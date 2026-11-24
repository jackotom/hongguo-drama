"""Resolve one Hongguo episode through the official SDK digest path.

The build script supplies the protocol modules and verified SDK materials
from the pinned reference source archive.
"""

import argparse
import gzip
import json
import os
import re
import secrets
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote, urlencode

if os.name == "nt":
    import errno
    import msvcrt
else:
    import fcntl

import requests

ROOT = Path(__file__).resolve().parent
for _candidate in (ROOT / "phone_account", ROOT / "vendor" / "phone_account"):
    if _candidate.is_dir():
        sys.path.insert(0, str(_candidate))
        break

from phone_account_device import parse_identity, prepare_registration, registration_cookies
from phone_playback_request_v5 import HOST as PLAYBACK_HOST, PATH as PLAYBACK_PATH, prepare_playback_v5
from phone_sdk_assets_v5 import load_assets
from phone_sdk_bootstrap_v5 import prepare_bootstrap, sign_prepared_v5
from phone_sdk_core_v5 import SdkDigestCore
from phone_sdk_exchange_v5 import exchange_response
from phone_sdk_materials_v5 import decode_app_config, read_sdk_image
from phone_sdk_session_v5 import send_prepared


STAGE = "start"
MAX_BATCH_VIDEOS = 8
VIDEO_ID_PATTERN = re.compile(r"[1-9][0-9]{7,23}")


def stage(name):
    global STAGE
    STAGE = name
    print(f"[sdk-playback] {name}", file=sys.stderr, flush=True)


def windows_cfg_enabled():
    if os.name != "nt":
        return False
    import ctypes
    from ctypes import wintypes

    class Policy(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD)]

    value = Policy()
    if not ctypes.windll.kernel32.GetProcessMitigationPolicy(
        ctypes.c_void_p(-1), 7, ctypes.byref(value), ctypes.sizeof(value)
    ):
        raise OSError("GetProcessMitigationPolicy failed")
    return bool(value.Flags & 1)


def load_device(cache):
    path = cache / "device.json"
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 128 * 1024:
            return None
        value = json.loads(path.read_text(encoding="utf8"))
        params = value.get("params")
        if not isinstance(params, dict) or params.get("aid") != "8662":
            return None
        if not str(params.get("device_id", "")).isdigit() or not str(params.get("iid", "")).isdigit():
            return None
        return {"params": params, "cookies": value.get("cookies", {})}
    except (OSError, ValueError, TypeError):
        return None


def save_device(cache, context):
    path = cache / "device.json"
    temporary = path.with_suffix(".tmp")
    if path.is_symlink() or temporary.is_symlink():
        raise RuntimeError("invalid device state path")
    data = json.dumps(context, separators=(",", ":")).encode("utf8")
    with temporary.open("wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    os.replace(temporary, path)


@contextmanager
def cache_lock(cache):
    if not cache.is_absolute() or cache.is_symlink():
        raise RuntimeError("invalid cache path")
    cache.mkdir(parents=True, exist_ok=True)
    for parent in cache.parents:
        if parent.is_symlink():
            raise RuntimeError("invalid cache path")
    path = cache / "init.lock"
    if path.is_symlink():
        raise RuntimeError("invalid cache lock path")
    with path.open("a+b") as stream:
        if os.fstat(stream.fileno()).st_nlink != 1:
            raise RuntimeError("invalid cache lock path")
        if os.name == "nt":
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"0")
                stream.flush()
            deadline = time.monotonic() + 90.0
            while True:
                stream.seek(0)
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EDEADLK) or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)
            try:
                yield
            finally:
                stream.seek(0)
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
        else:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def register(cache):
    cached = load_device(cache)
    if cached is not None:
        return cached
    url, body, headers, params = prepare_registration()
    with requests.Session() as client:
        client.trust_env = False
        response = client.post(
            url,
            data=body,
            headers=headers,
            timeout=(10, 25),
            allow_redirects=False,
            stream=True,
        )
        with response:
            if response.status_code != 200:
                raise RuntimeError(f"registration HTTP {response.status_code}")
            payload = bytearray()
            for chunk in response.iter_content(65536):
                payload.extend(chunk)
                if len(payload) > 2 * 1024 * 1024:
                    raise RuntimeError("registration response too large")
            identity = parse_identity(bytes(payload))
            cookies = registration_cookies(response, client)
    context = {
        "params": {
            **params,
            "device_id": identity["device_id"],
            "iid": identity["iid"],
        },
        "cookies": cookies,
    }
    save_device(cache, context)
    return context


def default_cache_dir():
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    return (base / "hongguo-drama" / "sdk-playback").resolve()


def normalize_videos(videos):
    items = videos.split(",") if isinstance(videos, str) else videos
    ordered = []
    seen = set()
    for part in items:
        video = str(part).strip()
        if not VIDEO_ID_PATTERN.fullmatch(video):
            raise ValueError("invalid-video-identity")
        if video not in seen:
            seen.add(video)
            ordered.append(video)
    if not ordered or len(ordered) > MAX_BATCH_VIDEOS:
        raise ValueError("invalid-video-batch-size")
    return ordered


def prepare_playback_batch_v5(
    context, videos, milliseconds, *, content_type, token, previous_ladon, materials, image, core
):
    ordered = normalize_videos(videos)
    if content_type not in ("1001", "1004"):
        raise ValueError("invalid-playback-content-type")
    if len(ordered) == 1:
        return prepare_playback_v5(
            context,
            ordered[0],
            milliseconds,
            content_type=content_type,
            token=token,
            previous_ladon=previous_ladon,
            materials=materials,
            image=image,
            core=core,
        )
    if not isinstance(context, dict) or not isinstance(context.get("params"), dict):
        raise ValueError("invalid-playback-context")
    cookies = context.get("cookies", {})
    if not isinstance(cookies, dict) or cookies.get("store-region-src") == "uid":
        raise ValueError("anonymous-playback-required")
    if type(milliseconds) is not int or not 0 <= milliseconds // 1000 <= 0xFFFFFFFF:
        raise ValueError("invalid-playback-time")
    params = dict(context["params"])
    if params.get("aid") != "8662":
        raise ValueError("invalid-playback-application")
    for name in ("device_id", "iid"):
        if not isinstance(params.get(name), str) or not re.fullmatch(r"[1-9][0-9]{4,29}", params[name]):
            raise ValueError("invalid-playback-identity")
    for name in ("cdid", "device_type", "device_brand", "os_version", "os_api", "dpi", "resolution"):
        value = params.get(name)
        if not isinstance(value, str) or not value or len(value) > 256 or any(
            ord(char) < 32 or ord(char) > 126 for char in value
        ):
            raise ValueError("invalid-playback-profile")
    params.update(
        version_code="74332",
        version_name="7.4.3.32",
        update_version_code="74332",
        manifest_version_code="74332",
        device_platform="android",
        os="android",
        _rticket=str(milliseconds),
    )
    names = (
        "device_platform os ssmix _rticket cdid channel aid app_name version_code version_name "
        "manifest_version_code update_version_code resolution dpi device_type device_brand "
        "language os_api os_version ac host_abi dragon_device_type pv_player compliance_status "
        "need_personal_recommend player_so_load is_android_pad_screen rom_version device_id iid klink_egdi"
    ).split()
    query = urlencode(
        [(name, params[name]) for name in names if params.get(name)],
        quote_via=quote,
        safe="*",
    ).encode("ascii")
    payload = {
        "dr_scene": "player",
        "mixed_video_id_map": {content_type: ordered},
        "biz_param": {
            "detail_page_version": 0,
            "device_level": 4,
            "disable_digg_stat": False,
            "need_all_video_definition": True,
            "need_mp4_align": False,
            "use_os_player": False,
            "use_server_dns": False,
            "video_platform": 1024,
        },
    }
    body = gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), mtime=0)
    request = sign_prepared_v5(
        params,
        cookies,
        query,
        body,
        milliseconds,
        token=token,
        previous_ladon=previous_ladon,
        materials=materials,
        image=image,
        core=core,
        origin="https://" + PLAYBACK_HOST,
        path=PLAYBACK_PATH,
    )
    request.headers.update(
        {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Encoding": "gzip",
            "Accept": "application/json",
            "X-Reading-Request": f"{milliseconds}-{100000000 + secrets.randbelow(900000000)}",
            "X-TT-Store-Region": cookies.get("store-region") or "cn",
            "X-TT-Store-Region-Src": "did",
            "X-SS-REQ-TICKET": str(milliseconds),
        }
    )
    return request


class SdkSession:
    HEAP_RESET_OFFSET = 0x600000

    def __init__(self, cache):
        self.cache = Path(cache).resolve()
        self.context = None
        self.assets = None
        self.materials = None
        self.image = None
        self.sdk_core = None
        self.token = None
        self.ladon = 0

    def _init_materials(self):
        if self.context is not None and self.sdk_core is not None:
            return
        # Parallel downloads may start with an empty cache; initialize its shared
        # device and SDK assets once before independent playback sessions begin.
        stage("cache-lock")
        with cache_lock(self.cache):
            stage("registration")
            self.context = register(self.cache)
            stage("assets")
            self.assets = load_assets(self.cache, allow_download=True)
        stage("materials")
        self.materials = decode_app_config(self.assets.configuration)
        self.image = read_sdk_image(self.assets.image)
        self.sdk_core = SdkDigestCore(self.assets.image)

    def _core(self, payload, selector, seconds):
        stage(f"digest-{selector}-start")
        digest = self.sdk_core.digest(payload, selector, seconds)[0][:16]
        stage(f"digest-{selector}-done")
        return digest

    def _reset_core_if_needed(self):
        if self.sdk_core is None or self.sdk_core.heap >= self.sdk_core.HEAP + self.HEAP_RESET_OFFSET:
            self.sdk_core = SdkDigestCore(self.assets.image)

    def _bootstrap(self):
        self._init_materials()
        self._reset_core_if_needed()
        stage("bootstrap-prepare")
        prepared = prepare_bootstrap(
            self.context,
            int(time.time() * 1000),
            materials=self.materials,
            image=self.image,
            core=self._core,
        )
        result = exchange_response(
            send_prepared(prepared),
            common=self.materials.exchange_key,
            inner=self.image.exchange_inner_key,
        )
        ladon = prepared.next_ladon
        if result.status == 202:
            stage("bootstrap-continue")
            prepared = prepare_bootstrap(
                self.context,
                int(time.time() * 1000),
                materials=self.materials,
                image=self.image,
                core=self._core,
                token=result.token,
                previous_ladon=ladon,
            )
            result = exchange_response(
                send_prepared(prepared),
                common=self.materials.exchange_key,
                inner=self.image.exchange_inner_key,
            )
            ladon = prepared.next_ladon
        if result.status != 200:
            raise RuntimeError(f"SDK session status {result.status}")
        self.token = result.token
        self.ladon = ladon

    def _resolve_many(self, videos, content_type):
        ordered = normalize_videos(videos)
        self._reset_core_if_needed()
        stage("playback-prepare")
        playback = prepare_playback_batch_v5(
            self.context,
            ordered,
            int(time.time() * 1000),
            content_type=content_type,
            token=self.token,
            previous_ladon=self.ladon,
            materials=self.materials,
            image=self.image,
            core=self._core,
        )
        self.ladon = playback.next_ladon
        stage("playback-send")
        payload = json.loads(send_prepared(playback))
        if payload.get("code") != 0:
            raise RuntimeError("SDK playback model unavailable")
        data = payload.get("data", {})
        entries = data.get(content_type, data)
        if not isinstance(entries, dict):
            raise RuntimeError("SDK playback model unavailable")
        models = {}
        for video in ordered:
            entry = entries.get(video)
            model = entry.get("video_model") if isinstance(entry, dict) else None
            if isinstance(model, str):
                try:
                    model = json.loads(model)
                except ValueError:
                    model = None
            if isinstance(model, dict):
                models[video] = model
        if not models:
            raise RuntimeError("SDK playback model unavailable")
        return models, playback.headers["User-Agent"]

    def resolve(self, video, content_type="1004"):
        return self.resolve_many([video], content_type)[video]

    def resolve_many(self, videos, content_type="1004"):
        ordered = normalize_videos(videos)
        if content_type not in ("1001", "1004"):
            raise ValueError("invalid-playback-content-type")
        reused = self.token is not None
        if not reused:
            self._bootstrap()
        try:
            models, user_agent = self._resolve_many(ordered, content_type)
        except Exception:
            if not reused:
                raise
            # Cached session token/ladon may have expired; re-bootstrap once.
            self.token = None
            self.ladon = 0
            self.sdk_core = None
            self._bootstrap()
            models, user_agent = self._resolve_many(ordered, content_type)
        return {
            video: {"model": models[video], "userAgent": user_agent}
            for video in ordered
            if video in models
        }


def _format_error(error):
    return f"{type(error).__name__}: {str(error)[:240]}"


def resolve(video, cache, content_type):
    return resolve_one(video, cache, content_type)


def resolve_one(video, cache, content_type):
    result = SdkSession(cache).resolve(video, content_type)
    return result["model"], result["userAgent"]


def resolve_batch(videos, cache, content_type):
    return SdkSession(cache).resolve_many(videos, content_type)


def serve(cache):
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    session = SdkSession(cache)
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            if "id" in request:
                req_id = request["id"]
            cmd = request.get("cmd")
            if cmd == "quit":
                reply = {"ok": True}
                if req_id is not None:
                    reply["id"] = req_id
                print(json.dumps(reply, separators=(",", ":")), flush=True)
                return 0
            if cmd == "ping":
                reply = {"ok": True}
                if req_id is not None:
                    reply["id"] = req_id
                print(json.dumps(reply, separators=(",", ":")), flush=True)
                continue
            content_type = str(request.get("contentType", "1004"))
            if request.get("videos") is not None:
                models = session.resolve_many(request["videos"], content_type)
                reply = {"ok": True, "models": {video: item["model"] for video, item in models.items()}}
                user_agents = {item["userAgent"] for item in models.values()}
                reply["userAgent"] = next(iter(user_agents)) if len(user_agents) == 1 else ""
            else:
                video = str(request.get("video", ""))
                result = session.resolve(video, content_type)
                reply = {"ok": True, "model": result["model"], "userAgent": result["userAgent"]}
        except Exception as error:
            reply = {
                "ok": False,
                "stage": STAGE,
                "error": _format_error(error),
            }
        if req_id is not None:
            reply["id"] = req_id
        print(json.dumps(reply, separators=(",", ":")), flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=False)
    target.add_argument("--video")
    target.add_argument("--videos")
    target.add_argument("--serve", action="store_true")
    parser.add_argument("--cache", type=Path, default=None)
    parser.add_argument("--content-type", default="1004", choices=("1001", "1004"))
    args = parser.parse_args()
    if not args.serve and not args.video and not args.videos:
        parser.error("--video, --videos, or --serve is required")
    cache = (args.cache or default_cache_dir()).resolve()
    try:
        stage("cfg-check")
        if windows_cfg_enabled():
            raise RuntimeError("Windows Control Flow Guard is enabled; rebuild the PyInstaller bootloader with --no-cfg")
        if args.serve:
            return serve(cache)
        if args.videos is not None:
            models = resolve_batch(args.videos, cache, args.content_type)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "models": {video: item["model"] for video, item in models.items()},
                        "userAgent": next(iter({item["userAgent"] for item in models.values()}), ""),
                    },
                    separators=(",", ":"),
                )
            )
            return 0
        model, user_agent = resolve_one(args.video, cache, args.content_type)
        print(json.dumps({
            "ok": True,
            "model": model,
            "userAgent": user_agent,
        }, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "stage": STAGE,
            "error": _format_error(error),
        }, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
