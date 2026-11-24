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

MAX_BATCH_VIDEOS = 10
VIDEO_ID_PATTERN = re.compile(r"[1-9][0-9]{7,23}")


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


def normalize_videos(videos):
    if isinstance(videos, str):
        items = [part.strip() for part in videos.split(",") if part.strip()]
    else:
        items = [str(part).strip() for part in videos if str(part).strip()]
    ordered = []
    seen = set()
    for item in items:
        if not VIDEO_ID_PATTERN.fullmatch(item):
            raise ValueError("invalid-video-identity")
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    if not ordered or len(ordered) > MAX_BATCH_VIDEOS:
        raise ValueError("invalid-video-batch-size")
    return ordered


def prepare_playback_batch_v5(context, videos, milliseconds, *, token, previous_ladon, materials, image, core):
    ordered = normalize_videos(videos)
    if len(ordered) == 1:
        return prepare_playback_v5(
            context,
            ordered[0],
            milliseconds,
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
        if not isinstance(value, str) or not value or len(value) > 256 or any(ord(c) < 32 or ord(c) > 126 for c in value):
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
    query = urlencode([(name, params[name]) for name in names if params.get(name)], quote_via=quote, safe="*").encode("ascii")
    payload = {
        "dr_scene": "player",
        "mixed_video_id_map": {"1004": ordered},
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
    request.headers.update({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Accept": "application/json",
        "X-Reading-Request": f"{milliseconds}-{100000000 + secrets.randbelow(900000000)}",
        "X-TT-Store-Region": cookies.get("store-region") or "cn",
        "X-TT-Store-Region-Src": "did",
        "X-SS-REQ-TICKET": str(milliseconds),
    })
    return request


def resolve_batch(videos, cache):
    ordered = normalize_videos(videos)
    # Parallel downloads may start with an empty cache; initialize its shared
    # device and SDK assets once before independent playback sessions begin.
    with cache_lock(cache):
        context = register(cache)
        assets = load_assets(cache, allow_download=True)
    materials = decode_app_config(assets.configuration)
    image = read_sdk_image(assets.image)
    sdk_core = SdkDigestCore(assets.image)

    def core(payload, selector, seconds):
        return sdk_core.digest(payload, selector, seconds)[0][:16]

    prepared = prepare_bootstrap(
        context,
        int(time.time() * 1000),
        materials=materials,
        image=image,
        core=core,
    )
    result = exchange_response(
        send_prepared(prepared),
        common=materials.exchange_key,
        inner=image.exchange_inner_key,
    )
    ladon = prepared.next_ladon
    if result.status == 202:
        prepared = prepare_bootstrap(
            context,
            int(time.time() * 1000),
            materials=materials,
            image=image,
            core=core,
            token=result.token,
            previous_ladon=ladon,
        )
        result = exchange_response(
            send_prepared(prepared),
            common=materials.exchange_key,
            inner=image.exchange_inner_key,
        )
        ladon = prepared.next_ladon
    if result.status != 200:
        raise RuntimeError(f"SDK session status {result.status}")

    playback = prepare_playback_batch_v5(
        context,
        ordered,
        int(time.time() * 1000),
        token=result.token,
        previous_ladon=ladon,
        materials=materials,
        image=image,
        core=core,
    )
    payload = json.loads(send_prepared(playback))
    if payload.get("code") != 0:
        raise RuntimeError("SDK playback model unavailable")
    data = payload.get("data", {})
    entries = data.get("1004", data)
    if not isinstance(entries, dict):
        raise RuntimeError("SDK playback model unavailable")
    models = {}
    for vid in ordered:
        entry = entries.get(vid)
        model = entry.get("video_model") if isinstance(entry, dict) else None
        if isinstance(model, str):
            try:
                model = json.loads(model)
            except ValueError:
                model = None
        if isinstance(model, dict):
            models[vid] = model
    if not models:
        raise RuntimeError("SDK playback model unavailable")
    return models, playback.headers["User-Agent"]


def resolve(video, cache):
    models, user_agent = resolve_batch([video], cache)
    model = models.get(video)
    if not isinstance(model, dict):
        raise RuntimeError("SDK playback model unavailable")
    return model, user_agent


def main():
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--video")
    target.add_argument("--videos")
    parser.add_argument("--cache", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.videos is not None:
            models, user_agent = resolve_batch(args.videos, args.cache)
            print(json.dumps({
                "ok": True,
                "models": models,
                "userAgent": user_agent,
            }, separators=(",", ":")))
        else:
            model, user_agent = resolve(args.video, args.cache)
            print(json.dumps({
                "ok": True,
                "model": model,
                "userAgent": user_agent,
            }, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "error": f"{type(error).__name__}: {str(error)[:240]}",
        }, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
