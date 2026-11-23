"""Independent Hongguo account-device initialization.

Uses an attributed MIT TTEncrypt dependency; no competitor implementation.
This module has no SMS, login or library-write operation. Account authentication
and MFA still need separate acceptance before the desktop login guard is removed.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
from http.cookies import SimpleCookie, CookieError
import json
import os
from pathlib import Path
import secrets
import struct
import sys
import time
from urllib.parse import urlencode
import uuid
from contextlib import contextmanager

import requests

VENDOR = Path(__file__).with_name("vendor")
CODEC_SHA256 = "2ac65ca1384fa94cade7246deeb066378724b7b2bc26cb76d22bbad024180f5b"
if hashlib.sha256((VENDOR / "TTEncrypt.py").read_bytes()).hexdigest() != CODEC_SHA256:
    raise RuntimeError("account-codec-integrity-failed")
sys.path.insert(0, str(VENDOR))
from TTEncrypt import TT as VendorTT


class TT(VendorTT):
    def hex_9C8(self):
        # The dependency draws integers through 256 inclusive, then truncates
        # them on the wire. A 256 consequently changes the encryption key at
        # decoding time. Supply actual bytes without modifying the vendor file.
        return list(secrets.token_bytes(32))

REGISTER_URL = "https://log.snssdk.com/service/2/device_register/"
MAX_RESPONSE = 2 * 1024 * 1024
VERSION_CODE = 73932
VERSION_NAME = "7.3.9.32"
USER_AGENT = (
    "com.phoenix.read/73932 (Linux; U; Android 14; zh_CN; Xiaomi 14; "
    "Build/UKQ1.230804.001; Cronet/TTNetVersion:8d40f833 "
    "QuicVersion:462f352c 2026-08-31)"
)
COOKIE_NAMES = {"odin_tt", "ttreq", "store-region", "store-region-src"}


class InitializationError(Exception):
    """Credential-free error safe for an IPC error response."""


def verify_dependency() -> None:
    if hashlib.sha256((VENDOR / "TTEncrypt.py").read_bytes()).hexdigest() != CODEC_SHA256:
        raise InitializationError("dependency-integrity-failed")


def valid_id(value: object) -> bool:
    return isinstance(value, (str, int)) and not isinstance(value, bool) and (
        str(value).isascii() and str(value).isdigit() and 5 <= len(str(value)) <= 30 and int(value) > 0
    )


def prepare_registration(now_ms: int | None = None) -> tuple[str, bytes, dict, dict]:
    """Build a fresh device request; time units and identity fields stay consistent."""
    verify_dependency()
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    cdid, openudid = str(uuid.uuid4()), secrets.token_hex(8)
    params = {
        "aid": "8662", "app_name": "novelread", "channel": "xiaomi_8662_64",
        "version_code": str(VERSION_CODE), "version_name": VERSION_NAME,
        "manifest_version_code": str(VERSION_CODE), "update_version_code": str(VERSION_CODE),
        "device_platform": "android", "os": "android", "ssmix": "a",
        "device_type": "23127PN0CC", "device_brand": "xiaomi", "os_api": "34", "os_version": "14",
        "resolution": "1200*2670", "dpi": "460", "ac": "wifi", "language": "zh",
        "openudid": openudid, "cdid": cdid, "tt_data": "a", "_rticket": str(ms), "ts": str(ms // 1000),
        "package": "com.phoenix.read", "first_launch_timestamp": str(ms // 1000),
        "last_deeplink_update_version_code": "0", "cpu_support64": "true", "host_abi": "arm64-v8a",
        "is_guest_mode": "0", "app_type": "normal", "minor_status": "0", "appTheme": "light",
        "is_preinstall": "0", "need_personal_recommend": "1", "is_android_pad": "0",
        "is_android_fold": "0", "md": "0", "cronet_version": "8d40f833_2026-03-03",
        "ttnet_version": "4.2.243.31-douyin", "use_store_region_cookie": "1",
    }
    header = {
        "access": "wifi", "aid": 8662, "app_version": VERSION_NAME, "app_version_minor": "",
        "apk_first_install_time": ms, "cdid": cdid, "channel": params["channel"],
        "clientudid": str(uuid.uuid4()), "cpu_abi": "arm64-v8a", "density_dpi": 460,
        "device_brand": "xiaomi", "device_category": "phone", "device_manufacturer": "Xiaomi",
        "device_model": "Xiaomi 14", "device_platform": "android", "display_density": "xxhdpi",
        "display_name": "红果短剧", "git_hash": "fe95b95", "guest_mode": 0, "ipv6_list": [],
        "is_system_app": 0, "language": "zh", "manifest_version_code": VERSION_CODE,
        "not_request_sender": 0, "oaid_may_support": True, "openudid": openudid, "os": "Android",
        "os_api": 34, "os_version": "14", "package": "com.phoenix.read", "region": "CN",
        "release_build": "UKQ1.230804.001_1701234567", "req_id": str(uuid.uuid4()),
        "resolution": "2670x1200", "rom": "hyperos", "rom_version": "OS1.0.32.0.UNCCNXM",
        "sdk_flavor": "china", "sdk_target_version": 29, "sdk_version": "3.7.3-rc.116-douyin",
        "sig_hash": "aea615ab910015038f73c47e45d21466", "sim_serial_number": [],
        "timezone": 8, "tz_name": "Asia/Shanghai", "tz_offset": 28800,
        "update_version_code": VERSION_CODE, "version_code": VERSION_CODE,
        "custom": {
            "is_android_fold": 0, "filter_warn": 0, "is_android_pad": 0, "client_ipv4": "0.0.0.0",
            "web_ua": "Mozilla/5.0 (Linux; Android 14; Xiaomi 14 Build/UKQ1.230804.001; wv) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36",
        },
    }
    payload = json.dumps({"magic_tag": "ss_app_log", "header": header, "_gen_time": ms},
                         ensure_ascii=False, separators=(",", ":"))
    body = TT().encrypt(payload)
    headers = {
        "Content-Type": "application/octet-stream;tt-data=a", "Content-Encoding": "gzip",
        "Accept-Encoding": "gzip", "User-Agent": USER_AGENT,
        "Accept": "application/json; charset=utf-8,application/x-protobuf",
        "X-SS-STUB": hashlib.md5(body).hexdigest().upper(), "X-SS-DP": "8662",
        "X-SS-REQ-TICKET": str(ms), "X-Khronos": str(ms // 1000),
        "X-Argus": base64.b64encode(struct.pack("<I", ms // 1000)).decode(),
        "X-TT-Request-Tag": "t=0;n=1", "Log-Encode-Type": "gzip", "Passport-SDK-Version": "60755",
        "Passport-SDK-Settings": "device_transfer_s_0,device_transfer_ab_1", "Sdk-Version": "2",
        "lc": "102", "X-TT-Store-Region": "cn", "X-TT-Store-Region-Src": "did",
        "X-VC-Bdturing-SDK-Version": "4.0.3.cn",
    }
    return REGISTER_URL + "?" + urlencode(sorted(params.items())), body, headers, params


def parse_identity(payload: bytes) -> dict:
    if len(payload) > MAX_RESPONSE:
        raise InitializationError("response-too-large")
    try:
        value = json.loads(TT().decrypt(payload) if payload.startswith(b"tc\x05\x10") else payload)
        if not isinstance(value, dict):
            raise ValueError()
        device = value.get("device_id_str") or value.get("device_id")
        install = value.get("install_id_str") or value.get("install_id")
        if not valid_id(device) or not valid_id(install):
            raise InitializationError("device-not-issued")
        token = value.get("device_token", "")
        if not isinstance(token, str) or len(token) > 8192:
            raise ValueError()
        return {"device_id": str(device), "iid": str(install), "device_token": token}
    except InitializationError:
        raise
    except Exception:
        raise InitializationError("invalid-registration-response") from None


def registration_cookies(response, client) -> dict:
    """Keep device bootstrap fields from the successful registration response.

    A general HTTP cookie jar can discard cookies whose Domain belongs to the
    playback service rather than the registration host. These four fields are
    explicit device-protocol outputs, not an account cookie jar. Read their
    original Set-Cookie fields; never import login cookies or arbitrary headers.
    """
    result = {k: v for k, v in client.cookies.get_dict().items()
              if k in COOKIE_NAMES and isinstance(v, str) and len(v) < 8192}
    headers = getattr(getattr(response, 'raw', None), 'headers', None)
    getlist = getattr(headers, 'getlist', None)
    lines = getlist('Set-Cookie') if callable(getlist) else []
    for line in lines[:32]:
        if not isinstance(line, str) or len(line) > 16384 or '\r' in line or '\n' in line:
            continue
        parsed = SimpleCookie()
        try:
            parsed.load(line)
        except CookieError:
            continue
        for name, item in parsed.items():
            value = item.value
            if name in COOKIE_NAMES and len(value) < 8192 and all(32 <= ord(c) < 127 for c in value):
                result[name] = value
    return result


def dpapi(data: bytes, decrypt: bool = False) -> bytes:
    if os.name != "nt":
        raise InitializationError("windows-protection-required")
    class Blob(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    source = ctypes.create_string_buffer(data)
    incoming = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    crypt = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not crypt(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise InitializationError("device-state-protection-failed")
    try:
        return ctypes.string_at(outgoing.data, outgoing.length)
    finally:
        ctypes.windll.kernel32.LocalFree(outgoing.data)


def load_context(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        if path.stat().st_size > 128 * 1024:
            raise ValueError()
        state = json.loads(dpapi(path.read_bytes(), decrypt=True))
        params = state["params"]
        if params["aid"] != "8662" or not valid_id(params["device_id"]) or not valid_id(params["iid"]):
            raise ValueError()
        return state
    except Exception:
        raise InitializationError("stored-device-invalid") from None


@contextmanager
def registration_lock(path):
    """OS lock releases on a crash; the diagnostic marker is not a mutex."""
    import msvcrt
    lock = path.with_suffix('.registration.lock')
    if lock.is_symlink() or (lock.exists() and lock.stat().st_nlink != 1):
        raise InitializationError('stored-device-invalid')
    with lock.open('a+b') as stream:
        if stream.tell() == 0:
            stream.write(b'0'); stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise InitializationError('registration-in-progress') from None
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def initialize_for_login(path):
    # Called only by the explicit send-code / confirmed QR-login action.
    # This never sends a code by itself and never replaces an existing context.
    return initialize(path, recover=True)


def initialize(path: Path, client_factory=requests.Session, *, recover=False) -> dict:
    state = load_context(path)
    if state is not None:
        return {'initialized': True, 'reused': True, 'authenticated': False}
    path.parent.mkdir(parents=True, exist_ok=True)
    with registration_lock(path):
        state = load_context(path)
        if state is not None:
            return {'initialized': True, 'reused': True, 'authenticated': False}
        pending = path.with_suffix('.registration.pending')
        if pending.exists():
            # A crash after the successful response must not register again.
            if pending.is_symlink() or pending.stat().st_nlink != 1:
                raise InitializationError('stored-device-invalid')
            load_context(pending)
            pending.rename(path)
            return {'initialized': True, 'reused': True, 'authenticated': False}
        marker = path.with_suffix('.attempt.json')
        if marker.exists() and recover:
            if marker.is_symlink() or marker.stat().st_nlink != 1 or marker.stat().st_size > 4096:
                raise InitializationError('previous-registration-needs-review')
            try:
                previous = json.loads(marker.read_text(encoding='utf8'))
                timestamp = previous['time']
                if type(timestamp) is not int or previous.get('status') not in ('started', 'failed'):
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise InitializationError('previous-registration-needs-review') from None
            if time.time() - timestamp < 60:
                raise InitializationError('registration-retry-cooldown')
            archive = path.with_suffix('.previous-attempt.json')
            if archive.is_symlink() or (archive.exists() and archive.stat().st_nlink != 1):
                raise InitializationError('previous-registration-needs-review')
            # Keep the prior result for diagnostics. One fresh attempt per
            # explicit action; background callers never enter this branch.
            marker.replace(archive)
        return _initialize_once(path, client_factory)


def _initialize_once(path: Path, client_factory=requests.Session) -> dict:
    """Reuse an existing context; one explicit network attempt if absent.

    A durable marker stops accidental replay after a timeout/crash. Recovery from
    a pending/failed attempt requires inspection, not an automatic retry loop.
    """
    state = load_context(path)
    if state is not None:
        return {"initialized": True, "reused": True, "authenticated": False}
    marker = path.with_suffix(".attempt.json")
    if marker.exists():
        raise InitializationError("previous-registration-needs-review")
    outcome = None
    try:
        # Local preparation is not a registration attempt. Validate it before
        # reserving the one-shot marker, so repairing a local component does
        # not require deleting an ambiguous network-attempt record.
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            url, body, headers, params = prepare_registration()
            probe = b'hongguo-device-protection-preflight-v1'
            if dpapi(dpapi(probe), decrypt=True) != probe:
                raise ValueError('Protection round trip failed')
            prepared_client = client_factory()
        except Exception:
            raise InitializationError('registration-preflight-failed') from None
        with prepared_client as client:
            try:
                with marker.open("x", encoding="utf8") as f:
                    json.dump({"status": "started", "time": int(time.time())}, f)
                    f.flush()
                    os.fsync(f.fileno())
            except FileExistsError:
                raise InitializationError("previous-registration-needs-review") from None
            outcome = "failed"
            with client.post(url, data=body, headers=headers, timeout=(10, 25),
                             allow_redirects=False, stream=True) as response:
                if response.status_code != 200:
                    raise InitializationError("registration-http-rejected")
                payload = bytearray()
                for chunk in response.iter_content(64 * 1024):
                    if len(payload) + len(chunk) > MAX_RESPONSE:
                        raise InitializationError("response-too-large")
                    payload.extend(chunk)
                identity = parse_identity(bytes(payload))
                cookies = registration_cookies(response, client)
        state = {"schema": 1, "params": {**params, "device_id": identity["device_id"], "iid": identity["iid"]},
                 "device_token": identity["device_token"], "cookies": cookies, "user_agent": USER_AGENT}
        encrypted = dpapi(json.dumps(state).encode())
        # Exclusive creation also prevents a race from replacing an initialized device.
        pending = path.with_suffix('.registration.pending')
        with pending.open("xb") as f:
            f.write(encrypted)
            f.flush()
            os.fsync(f.fileno())
        # Windows rename fails if the destination exists; it cannot overwrite
        # another initialized identity, and avoids a partially written context.
        pending.rename(path)
        outcome = "registered"
        return {"initialized": True, "reused": False, "authenticated": False}
    except InitializationError:
        raise
    except Exception:
        raise InitializationError("registration-incomplete" if outcome is not None
                                  else "registration-preflight-failed") from None
    finally:
        if outcome is not None:
            marker.write_text(json.dumps({"status": outcome, "time": int(time.time())}), encoding="utf8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-file", required=True, type=Path)
    parser.add_argument("--initialize", action="store_true", help="Explicit one-shot registration if no stored device")
    args = parser.parse_args()
    try:
        result = initialize(args.state_file) if args.initialize else {
            "initialized": load_context(args.state_file) is not None, "authenticated": False
        }
        print(json.dumps(result))
        return 0
    except InitializationError as error:
        print(json.dumps({"initialized": False, "authenticated": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
