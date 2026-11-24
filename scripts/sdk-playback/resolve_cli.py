"""Resolve one Hongguo episode through the official SDK digest path.

The build script supplies the protocol modules and verified SDK materials
from the pinned reference source archive.
"""

import argparse
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path

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
from phone_playback_request_v5 import prepare_playback_v5
from phone_sdk_assets_v5 import load_assets
from phone_sdk_bootstrap_v5 import prepare_bootstrap
from phone_sdk_core_v5 import SdkDigestCore
from phone_sdk_exchange_v5 import exchange_response
from phone_sdk_materials_v5 import decode_app_config, read_sdk_image
from phone_sdk_session_v5 import send_prepared


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
        with cache_lock(self.cache):
            self.context = register(self.cache)
            self.assets = load_assets(self.cache, allow_download=True)
        self.materials = decode_app_config(self.assets.configuration)
        self.image = read_sdk_image(self.assets.image)
        self.sdk_core = SdkDigestCore(self.assets.image)

    def _core(self, payload, selector, seconds):
        return self.sdk_core.digest(payload, selector, seconds)[0][:16]

    def _reset_core_if_needed(self):
        if self.sdk_core is None or self.sdk_core.heap >= self.sdk_core.HEAP + self.HEAP_RESET_OFFSET:
            self.sdk_core = SdkDigestCore(self.assets.image)

    def _bootstrap(self):
        self._init_materials()
        self._reset_core_if_needed()
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

    def _resolve_once(self, video):
        self._reset_core_if_needed()
        playback = prepare_playback_v5(
            self.context,
            video,
            int(time.time() * 1000),
            token=self.token,
            previous_ladon=self.ladon,
            materials=self.materials,
            image=self.image,
            core=self._core,
        )
        self.ladon = playback.next_ladon
        payload = json.loads(send_prepared(playback))
        data = payload.get("data", {})
        entries = data.get("1004", data)
        model = entries.get(video, {}).get("video_model")
        if isinstance(model, str):
            model = json.loads(model)
        if payload.get("code") != 0 or not isinstance(model, dict):
            raise RuntimeError("SDK playback model unavailable")
        return model, playback.headers["User-Agent"]

    def resolve(self, video):
        if not isinstance(video, str) or not re.fullmatch(r"[1-9][0-9]{7,23}", video):
            raise ValueError("invalid-video-identity")
        reused = self.token is not None
        if not reused:
            self._bootstrap()
        try:
            return self._resolve_once(video)
        except Exception:
            if not reused:
                raise
            # Cached session token/ladon may have expired; re-bootstrap once.
            self.token = None
            self.ladon = 0
            self.sdk_core = None
            self._bootstrap()
            return self._resolve_once(video)


def resolve(video, cache):
    return SdkSession(cache).resolve(video)


def _format_error(error):
    return f"{type(error).__name__}: {str(error)[:240]}"


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
            video = request.get("video")
            if not isinstance(video, str):
                video = str(video) if video is not None else ""
            model, user_agent = session.resolve(video)
            reply = {
                "ok": True,
                "model": model,
                "userAgent": user_agent,
            }
        except Exception as error:
            reply = {
                "ok": False,
                "error": _format_error(error),
            }
        if req_id is not None:
            reply["id"] = req_id
        print(json.dumps(reply, separators=(",", ":")), flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--cache", type=Path, default=None)
    args = parser.parse_args()
    if not args.serve and not args.video:
        parser.error("--video is required unless --serve is specified")
    cache = (args.cache or default_cache_dir()).resolve()
    if args.serve:
        return serve(cache)
    try:
        model, user_agent = resolve(args.video, cache)
        print(json.dumps({
            "ok": True,
            "model": model,
            "userAgent": user_agent,
        }, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "error": _format_error(error),
        }, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
