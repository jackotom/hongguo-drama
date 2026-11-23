"""Resolve one Hongguo episode through the official SDK digest path.

The build script supplies the protocol modules and verified SDK materials
from the pinned reference source archive.
"""

import argparse
import fcntl
import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "phone_account"))

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
    os.chmod(temporary, 0o600)
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
    with path.open("a+") as stream:
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


def resolve(video, cache):
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

    playback = prepare_playback_v5(
        context,
        video,
        int(time.time() * 1000),
        token=result.token,
        previous_ladon=ladon,
        materials=materials,
        image=image,
        core=core,
    )
    payload = json.loads(send_prepared(playback))
    data = payload.get("data", {})
    entries = data.get("1004", data)
    model = entries.get(video, {}).get("video_model")
    if isinstance(model, str):
        model = json.loads(model)
    if payload.get("code") != 0 or not isinstance(model, dict):
        raise RuntimeError("SDK playback model unavailable")
    return model, playback.headers["User-Agent"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--cache", required=True, type=Path)
    args = parser.parse_args()
    try:
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
