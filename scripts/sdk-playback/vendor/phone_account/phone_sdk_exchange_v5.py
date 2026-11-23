"""Independent bounded SDI wire codec; no transport or implicit SDK session.

Uses the documented SDI framing and standard AES-CBC, XTEA-CBC, CRC16 and zlib.
Original application materials must be supplied by the caller. This component
does not read credentials, invent a device, send requests, or persist tokens.
"""
import binascii
from dataclasses import dataclass, field
import struct
import zlib

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
from phone_account_medusa import protobuf
from phone_sdk_materials_v5 import wire_fields

MAX_PLAIN = 65536
MASK = 0xffffffff
DELTA = 0x9e3779b9


@dataclass(frozen=True)
class SdkSessionResult:
    token: str = field(repr=False)
    status: int


def _keys(common, inner):
    if not isinstance(common, bytes) or len(common) != 32 or not isinstance(inner, bytes) or len(inner) != 16:
        raise ValueError('invalid-sdk-exchange-materials')


def xtea_chain(data, key, nonce, *, decrypt=False):
    if not isinstance(data, bytes) or not data or len(data) % 8 or len(data) > MAX_PLAIN * 2:
        raise ValueError('invalid-xtea-blocks')
    if not isinstance(key, bytes) or len(key) != 16 or not isinstance(nonce, bytes) or len(nonce) != 4:
        raise ValueError('invalid-xtea-materials')
    key_words = struct.unpack('>4I', key)
    cycles = 32 + 8 * (int.from_bytes(nonce, 'little') % 5)
    previous = nonce + struct.pack('<I', 0x20200427)
    result = bytearray()
    for offset in range(0, len(data), 8):
        source = data[offset:offset + 8]
        block = source if decrypt else bytes(a ^ b for a, b in zip(source, previous))
        words = list(struct.unpack('>2I', block))
        steps = range(cycles * 2 - 1, -1, -1) if decrypt else range(cycles * 2)
        for step in steps:
            target = step & 1
            total = ((step + 1) // 2 * DELTA) & MASK
            other = words[1 - target]
            key_index = (total >> (11 * target)) & 3
            mix = ((((other << 4) ^ (other >> 5)) + other) & MASK) ^ ((total + key_words[key_index]) & MASK)
            words[target] = (words[target] + (-mix if decrypt else mix)) & MASK
        transformed = struct.pack('>2I', *words)
        result.extend(bytes(a ^ b for a, b in zip(transformed, previous)) if decrypt else transformed)
        previous = source if decrypt else transformed
    return bytes(result)


def encrypt_payload(plaintext, *, common, inner, nonce, entropy_byte):
    _keys(common, inner)
    if not isinstance(plaintext, bytes) or len(plaintext) > MAX_PLAIN:
        raise ValueError('invalid-sdk-plaintext')
    if type(entropy_byte) is not int or not 0 <= entropy_byte <= 255:
        raise ValueError('invalid-sdk-entropy')
    compressed = zlib.compress(plaintext)
    compressed = b'\x78\x01' + compressed[2:]
    container = struct.pack('<I', len(plaintext)) + compressed
    extra = (-len(container)) % 8
    position = 1 + ((extra - 1) % 4)
    frame = bytearray(len(container) + 8 + extra)
    frame[0] = (entropy_byte & 0xf8) | extra
    frame[position:position + len(container)] = container
    crc_offset = 1 if position >= 3 else position + len(container)
    frame[crc_offset:crc_offset + 2] = struct.pack('>H', binascii.crc_hqx(container, 0))
    encrypted = xtea_chain(bytes(frame), inner, nonce)
    wrapped = bytes([encrypted[0] ^ 3]) + encrypted + nonce
    return AES.new(common[:16], AES.MODE_CBC, common[16:]).encrypt(pad(wrapped, 16))


def decrypt_payload(ciphertext, *, common, inner, response_frame=False):
    _keys(common, inner)
    if not isinstance(ciphertext, bytes) or not ciphertext or len(ciphertext) % 16 or len(ciphertext) > MAX_PLAIN * 2:
        raise ValueError('invalid-sdk-ciphertext')
    try:
        wrapped = unpad(AES.new(common[:16], AES.MODE_CBC, common[16:]).decrypt(ciphertext), 16)
    except ValueError:
        raise ValueError('invalid-sdk-padding') from None
    if len(wrapped) < 13 or (len(wrapped) - 5) % 8 or wrapped[0] ^ wrapped[1] != 3:
        raise ValueError('invalid-sdk-outer-frame')
    frame = xtea_chain(wrapped[1:-4], inner, wrapped[-4:], decrypt=True)
    extra = frame[0] & 7
    length = len(frame) - 8 - extra
    position = 1 + ((extra - 1) % 4)
    if length < 4:
        raise ValueError('invalid-sdk-inner-frame')
    container = frame[position:position + length]
    crc_offset = 1 if position >= 3 else position + length
    expected_crc = struct.pack('>H', binascii.crc_hqx(container, 0))
    # CRC16 occupies the request-frame padding. The response protocol has
    # not established that padding as CRC16; applying the request constraint
    # there rejects otherwise decodable server messages. Response validation
    # still requires AES padding, the full outer byte, exact bounded zlib
    # inflation (including Adler32), and the session protobuf/status below.
    if not response_frame and frame[crc_offset:crc_offset + 2] != expected_crc:
        raise ValueError('invalid-sdk-inner-checksum')
    expected_size = int.from_bytes(container[:4], 'little')
    if expected_size > MAX_PLAIN:
        raise ValueError('sdk-response-too-large')
    try:
        decoder = zlib.decompressobj()
        value = decoder.decompress(container[4:], expected_size + 1)
    except zlib.error:
        raise ValueError('invalid-sdk-compression') from None
    if len(value) != expected_size or not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
        raise ValueError('invalid-sdk-decoded-size')
    return value


def exchange_request(plaintext, milliseconds, *, common, inner, nonce, entropy_byte):
    if type(milliseconds) is not int or not 0 <= milliseconds < 1 << 63:
        raise ValueError('invalid-sdk-request-time')
    ciphertext = encrypt_payload(plaintext, common=common, inner=inner, nonce=nonce, entropy_byte=entropy_byte)
    return protobuf([(1, 0x20200422 * 2), (2, 2), (3, 2), (4, ciphertext), (5, milliseconds * 2)])


def exchange_response(packet, *, common, inner):
    fields = {}
    for number, encoding, value in wire_fields(packet, limit=MAX_PLAIN * 2):
        if number in (1, 2):
            if encoding != 0 or (number in fields and fields[number] != value):
                raise ValueError('invalid-sdk-response-header')
        elif number == 3:
            if encoding != 0:
                raise ValueError('invalid-sdk-response-status')
        elif number == 6:
            if encoding != 2 or number in fields:
                raise ValueError('invalid-sdk-response-ciphertext')
        else:
            continue
        fields[number] = value
    if fields.get(1) != 0x20120312 * 2 or fields.get(2) != 2:
        raise ValueError('invalid-sdk-response-header')
    if 6 not in fields:
        code = fields.get(3)
        if code is not None:
            raise ValueError(f'sdk-exchange-refused:{(code >> 1) ^ -(code & 1)}')
        raise ValueError('missing-sdk-response-ciphertext')
    decoded = decrypt_payload(fields[6], common=common, inner=inner, response_frame=True)
    result = {}
    for number, encoding, value in wire_fields(decoded):
        if number not in (1, 2):
            continue
        if number in result or encoding != (2 if number == 1 else 0):
            raise ValueError('invalid-sdk-session-fields')
        result[number] = value
    if set(result) != {1, 2}:
        raise ValueError('incomplete-sdk-session')
    status = (result[2] >> 1) ^ -(result[2] & 1)
    if status not in (200, 202):
        raise ValueError(f'sdk-session-status:{status}')
    try:
        token = result[1].decode('utf8')
    except UnicodeError:
        raise ValueError('invalid-sdk-session-token') from None
    if not token or len(result[1]) > 256 or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise ValueError('invalid-sdk-session-token')
    return SdkSessionResult(token, status)
