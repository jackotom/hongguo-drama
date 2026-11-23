"""Decode original-app SDK configuration without embedding its contents.

Protocol-format implementation uses standard AES/RC4 primitives. Callers supply
the original, integrity-checked APK configuration; no account/session defaults.
This module has no filesystem, network, logging or production transport access.
"""
import base64
from dataclasses import dataclass, field
import hashlib

from Crypto.Cipher import AES, ARC4


@dataclass(frozen=True)
class SdkMaterials:
    signing_key: bytes = field(repr=False)
    exchange_key: bytes = field(repr=False)


@dataclass(frozen=True)
class SdkImageParts:
    frame: bytes = field(repr=False)
    substitutions: bytes = field(repr=False)
    exchange_inner_key: bytes = field(repr=False)
    unavailable: str


def read_sdk_image(image):
    if not isinstance(image, bytes) or len(image) != 4501136 or hashlib.sha256(image).hexdigest() != 'c6831ab265a0cb76dacfa3b7041e9ea0f706490106a74e12f39058671cc14fe3':
        raise ValueError('unsupported-original-sdk-image')
    inner = image[0x66690:0x66698] + bytes(a ^ b for a, b in
        zip(image[0x9d08c:0x9d094], image[0x9d118:0x9d120]))
    return SdkImageParts(image[0x665f0:0x66600], image[0xffcf9:0x1000f9], inner,
                         image[0x66c44:0x66c4c].decode('ascii'))


def wire_fields(data, *, limit=8192):
    """Strict bounded protobuf reader for SDK metadata; preserves repeats."""
    if not isinstance(data, bytes) or len(data) > limit:
        raise ValueError('invalid-sdk-wire-data')
    cursor = 0
    def integer():
        nonlocal cursor
        result = 0
        for part in range(10):
            if cursor >= len(data):
                raise ValueError('truncated-sdk-wire-number')
            byte = data[cursor]
            cursor += 1
            if part == 9 and byte > 1:
                raise ValueError('overflow-sdk-wire-number')
            result |= (byte & 127) << (7 * part)
            if byte < 128:
                return result
        raise ValueError('invalid-sdk-wire-number')
    rows = []
    while cursor < len(data):
        tag = integer()
        number, encoding = tag >> 3, tag & 7
        if not 1 <= number < 1 << 29:
            raise ValueError('invalid-sdk-wire-field')
        if encoding == 0:
            value = integer()
        elif encoding in (1, 2, 5):
            size = integer() if encoding == 2 else (8 if encoding == 1 else 4)
            if size > len(data) - cursor:
                raise ValueError('truncated-sdk-wire-field')
            value = data[cursor:cursor + size]
            cursor += size
        else:
            raise ValueError('unsupported-sdk-wire-encoding')
        rows.append((number, encoding, value))
        if len(rows) > 512:
            raise ValueError('too-many-sdk-wire-fields')
    return rows


def _key_entries(message):
    found = {}
    for number, encoding, item in wire_fields(message):
        if number != 8:
            continue
        if encoding != 2:
            raise ValueError('invalid-sdk-key-entry')
        entry = {}
        for subfield, subencoding, value in wire_fields(item):
            if subfield not in (1, 2) or subencoding != 2 or subfield in entry:
                raise ValueError('invalid-sdk-key-entry')
            entry[subfield] = value
        if set(entry) != {1, 2}:
            raise ValueError('incomplete-sdk-key-entry')
        name = entry[1]
        if name not in (b'sign_key', b'common_key') or name in found:
            raise ValueError('unexpected-sdk-key-entry')
        try:
            key = base64.b64decode(entry[2], validate=True)
        except Exception:
            raise ValueError('invalid-sdk-key-format') from None
        if len(key) != 32:
            raise ValueError('invalid-sdk-key-size')
        found[name] = key
    if set(found) != {b'sign_key', b'common_key'}:
        raise ValueError('missing-sdk-key-entry')
    return SdkMaterials(found[b'sign_key'], found[b'common_key'])


def decode_app_config(encoded, *, app_id='8662'):
    if not isinstance(encoded, bytes) or len(encoded) != 304:
        raise ValueError('invalid-sdk-config-size')
    if not isinstance(app_id, str) or not app_id.isascii() or not app_id.isdigit() or not 1 <= len(app_id) <= 12:
        raise ValueError('invalid-sdk-app-id')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception:
        raise ValueError('invalid-sdk-config-base64') from None
    if len(raw) != 228:
        raise ValueError('invalid-sdk-config-frame')
    application = app_id.encode('ascii')
    nonce = raw[:4]
    wrapping_key = hashlib.md5(application + nonce + application).digest()
    plaintext = AES.new(wrapping_key, AES.MODE_ECB).decrypt(raw[4:])
    padding = plaintext[-1]
    if not 1 <= padding <= 16 or plaintext[-padding:] != bytes([padding]) * padding:
        raise ValueError('invalid-sdk-config-padding')
    plaintext = plaintext[:-padding]
    if len(plaintext) < 9:
        raise ValueError('invalid-sdk-config-payload')
    head, tail = plaintext[:4], plaintext[-4:]
    mask = 0
    for byte in nonce + head + tail:
        mask ^= byte
    stream_key = hashlib.sha1(head + application + nonce).digest()
    payload = ARC4.new(stream_key).decrypt(plaintext[4:-4])
    message = bytes(byte ^ mask for byte in reversed(payload))
    return _key_entries(message)
