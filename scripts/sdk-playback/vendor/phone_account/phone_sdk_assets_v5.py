"""Verified, bounded cache of the original application's SDK inputs.

No SDK image/configuration is embedded in this project. A caller explicitly
enables first-use download; valid cache reads never access the network.
"""
from dataclasses import dataclass, field
import hashlib
from pathlib import Path
import os
import tempfile
import time
import zlib
from urllib.parse import urljoin, urlsplit

# Official app8662 download, observed 2026-11-19. The extracted SDK inputs
# retain their existing hashes/cache identity; only the APK container changed.
APK = 'https://lf9-apk.ugapk.cn/package/apk/novelread/12267_74532/novelread_69321526a_v12267_74532_46e0_1794485793.apk?v=1794485793'
APK_SIZE = 156400488
CONFIG_OFFSET = 1918408
IMAGE_NAME = 'libmetasec_ml.so'
CONFIG_NAME = 'sdk-app-config.encoded'
FILES = {
    IMAGE_NAME: (4501136, 'c6831ab265a0cb76dacfa3b7041e9ea0f706490106a74e12f39058671cc14fe3'),
    CONFIG_NAME: (304, '584a01183f1e6783326bff49d4f1319f33fcce678afb93ca0dc8b60a56b65855'),
}
PARTS = {
    IMAGE_NAME: (115882007, 1497823, '3839797f0a1e0ef6c604d639d0054a527b99ed1fa6aa9ecd2e80a9d87c8d133f', 4501136),
    CONFIG_NAME: (68002997, 3914490, 'e7c9cc2356ed194f4971c9f45687425d8dd7a2c445266a5a6f4fc3947417872d', 10367780),
}


class SdkAssetsError(ValueError):
    pass


def _redirect(current, location, visited):
    # Validate the raw header before urllib can strip whitespace/controls.
    if (not isinstance(location, str) or not location or len(location) > 8192
            or any(ord(c) < 33 or ord(c) == 127 for c in location)):
        raise SdkAssetsError('sdk-material-redirect-invalid')
    try:
        target = urljoin(current, location)
        parts = urlsplit(target)
        host, port = parts.hostname or '', parts.port
    except ValueError:
        raise SdkAssetsError('sdk-material-redirect-invalid') from None
    if (parts.scheme != 'https' or parts.username is not None or parts.password is not None
            or parts.fragment or port not in (None, 443, 20443)
            or not any(host == suffix or host.endswith('.' + suffix) for suffix in ('ugapk.cn', 'jspcdn.cn'))
            or any(ord(c) < 33 or ord(c) == 127 for c in target) or target in visited):
        raise SdkAssetsError('sdk-material-redirect-invalid')
    return target


@dataclass(frozen=True)
class SdkAssets:
    image: bytes = field(repr=False)
    configuration: bytes = field(repr=False)


def _verify(data, size, digest):
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise SdkAssetsError('sdk-material-integrity-failed')
    return data


def _inflate(packed, limit):
    decoder = zlib.decompressobj(-15)
    try:
        result = decoder.decompress(packed, limit + 1)
    except zlib.error:
        raise SdkAssetsError('sdk-material-compression-invalid') from None
    if len(result) != limit or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise SdkAssetsError('sdk-material-size-invalid')
    return result


def _download(name, client_factory):
    import requests
    start, size, digest, unpacked = PARTS[name]
    end = start + size - 1
    factory = client_factory or requests.Session
    with factory() as client:
        client.trust_env = False
        client.auth = None
        client.cookies.clear()
        client.headers.clear()
        started = time.monotonic()
        url = APK
        visited = {url}
        for hop in range(3):
            # A redirect is CDN routing, not permission to retry a failed read.
            # Rebuild only the anonymous range headers; never forward cookies.
            request = requests.Request('GET', url, headers={'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'}).prepare()
            if client.get_adapter(url).max_retries.total != 0:
                raise SdkAssetsError('sdk-material-retry-disabled')
            remaining = 45 - (time.monotonic() - started)
            if remaining <= 0:
                raise SdkAssetsError('sdk-material-transfer-limit')
            with client.send(request, timeout=(min(8, remaining), min(20, remaining)), verify=True, allow_redirects=False, stream=True) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    if hop == 2:
                        raise SdkAssetsError('sdk-material-redirect-limit')
                    url = _redirect(url, response.headers.get('Location'), visited)
                    visited.add(url)
                    client.cookies.clear()
                    continue
                if response.status_code != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{APK_SIZE}':
                    raise SdkAssetsError('sdk-material-range-unavailable')
                if response.headers.get('Content-Encoding', 'identity') != 'identity':
                    raise SdkAssetsError('sdk-material-encoding-invalid')
                packed = bytearray()
                for chunk in response.iter_content(65536):
                    if len(packed) + len(chunk) > size or time.monotonic() - started > 45:
                        raise SdkAssetsError('sdk-material-transfer-limit')
                    packed.extend(chunk)
                break
        _verify(packed, size, digest)
    result = _inflate(packed, unpacked)
    if name == CONFIG_NAME:
        # The compressed range digest fixes the entire DEX bytes. Only the
        # pinned configuration is retained; the DEX never reaches the cache.
        result = result[CONFIG_OFFSET:CONFIG_OFFSET + FILES[CONFIG_NAME][0]]
    return _verify(result, *FILES[name])


def load_assets(directory, *, allow_download=False, client_factory=None):
    root = Path(directory)
    if not root.is_absolute() or root.is_symlink():
        raise SdkAssetsError('sdk-cache-path-invalid')
    for parent in root.parents:
        if parent.is_symlink(): raise SdkAssetsError('sdk-cache-path-invalid')
    if not root.exists():
        if not allow_download: raise SdkAssetsError('sdk-materials-not-installed')
        root.mkdir(parents=True)
    if not root.is_dir(): raise SdkAssetsError('sdk-cache-path-invalid')
    results = {}
    for name, (size, digest) in FILES.items():
        target = root / name
        if target.is_symlink(): raise SdkAssetsError('sdk-cache-path-invalid')
        if target.exists():
            if not target.is_file() or target.stat().st_size != size:
                raise SdkAssetsError('sdk-material-integrity-failed')
            results[name] = _verify(target.read_bytes(), size, digest)
            continue
        if not allow_download: raise SdkAssetsError('sdk-materials-not-installed')
        data = _download(name, client_factory)
        handle, temporary = tempfile.mkstemp(prefix='.sdk-', suffix='.tmp', dir=root)
        try:
            with os.fdopen(handle, 'wb') as file:
                file.write(data); file.flush(); os.fsync(file.fileno())
            # Only install missing immutable inputs; another writer's result
            # must verify before accepting it. Never replace a corrupt cache.
            if target.exists():
                _verify(target.read_bytes(), size, digest)
            else:
                os.rename(temporary, target)
            results[name] = data
        finally:
            if Path(temporary).exists(): Path(temporary).unlink()
    return SdkAssets(results[IMAGE_NAME], results[CONFIG_NAME])
