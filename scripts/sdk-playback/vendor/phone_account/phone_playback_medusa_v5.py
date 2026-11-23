"""Independent V5 wire primitives; intentionally not a complete live signer.

Substitution tables must be supplied by the caller. No competitor SDK image or
asset is embedded. Reuses our independently validated matrix operations; current
login/playback defaults do not import this module.
"""
import base64
import hashlib
import struct

from phone_account_medusa_cipher import MedusaCipher, derive_scramble_key, scramble, xor

# Wire parameters observed with synthetic identity substitution tables. These
# four permutations and round constants differ from the existing V3 protocol.
ROUND_CONSTANTS = (0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9)
ROW_ORDERS = ((2, 0, 3, 1), (1, 3, 2, 0), (3, 2, 1, 0), (2, 3, 1, 0))
LAST_COLUMN = ((15, 7, 3, 11), (11, 3, 15, 7), (3, 15, 11, 7), (15, 3, 11, 7))
SOURCE_BITS = (6, 5, 3, 4, 2, 7, 1, 0)
PACKED_BITS = (1, 7, 3, 6, 2, 0, 4, 5)


class V5BlockCipher(MedusaCipher):
    def __init__(self, key: bytes, substitution: bytes, variant: int):
        if not isinstance(key, bytes) or len(key) != 16:
            raise ValueError('invalid-wire-key')
        if type(variant) is not int or not 0 <= variant < 4:
            raise ValueError('invalid-wire-variant')
        if not isinstance(substitution, bytes) or len(substitution) != 256:
            raise ValueError('invalid-substitution-table')
        self.box = substitution
        self.rows = ROW_ORDERS[variant]
        self.shift = tuple(LAST_COLUMN[variant][index // 4] if index % 4 == 3
                           else (index + (0, 8, 12)[index % 4]) % 16 for index in range(16))
        constant = ROUND_CONSTANTS[variant]
        initial = xor(key, struct.pack('<I', constant) * 4)
        words = [initial[i:i + 4] for i in range(0, 16, 4)]
        for index in range(4, 12):
            previous = words[-1]
            if index % 4 == 0:
                rotated = previous[1:] + previous[:1]
                previous = bytes(self.box[byte] for byte in rotated)
                round_byte = (constant >> ((2 * index) & 24)) & 255
                previous = bytes((previous[0] ^ round_byte,)) + previous[1:]
            words.append(xor(words[index - 4], previous))
        self.keys = [b''.join(words[index:index + 4]) for index in (0, 4, 8)]


def compact_cipher_v5(payload: bytes, seconds: int, key_material: bytes, substitution_tables: bytes) -> bytes:
    """Encrypt sampled payload bits into the V5 compact 32-byte wire block."""
    if not isinstance(payload, bytes) or len(payload) < 248:
        raise ValueError('invalid-wire-payload')
    if type(seconds) is not int or not 0 <= seconds <= 0xffffffff:
        raise ValueError('invalid-signing-time')
    if not isinstance(key_material, bytes) or len(key_material) != 32:
        raise ValueError('invalid-wire-key-material')
    if not isinstance(substitution_tables, bytes) or len(substitution_tables) != 1024:
        raise ValueError('invalid-substitution-tables')
    sampled = bytes(sum(((payload[group * 8 + bit] >> SOURCE_BITS[bit]) & 1) << PACKED_BITS[bit]
                        for bit in range(8)) for group in range(31)) + b'\x01'
    variant = seconds & 3
    cipher = V5BlockCipher(hashlib.md5(key_material[:16]).digest(),
                          substitution_tables[variant * 256:(variant + 1) * 256], variant)
    first = cipher.block(xor(sampled[:16], hashlib.md5(key_material[16:]).digest()))
    return first + cipher.block(xor(sampled[16:], first))


def envelope_v5(proto: bytes, query_digest: bytes, body_proof: bytes, seconds: int,
                key_nonce: int, frame_nonce: int, *, seed: bytes, frame: bytes,
                prefix: bytes, substitution_tables: bytes) -> str:
    """Seal an already validated V5 proof message; no digest generation or I/O."""
    for value, size in ((query_digest, 32), (body_proof, 20), (seed, 32),
                        (frame, 16), (prefix, 8), (substitution_tables, 1024)):
        if not isinstance(value, bytes) or len(value) != size:
            raise ValueError('invalid-wire-component')
    if not isinstance(proto, bytes) or not 229 <= len(proto) <= 1024 * 1024:
        raise ValueError('invalid-proof-message')
    for value in (seconds, key_nonce, frame_nonce):
        if type(value) is not int or not 0 <= value <= 0xffffffff:
            raise ValueError('invalid-wire-counter')
    key, mask = derive_scramble_key(seed, key_nonce)
    mixed = bytes(reversed(prefix + scramble(proto, key)))
    mixed = bytes(value ^ mask[(~index) & 3] for index, value in enumerate(mixed))
    flags = 0x18000001 | ((query_digest[0] & 63) << 14) | ((body_proof[0] & 63) << 8)
    payload = bytearray(b'\xca' + struct.pack('<II', frame_nonce, flags) + mixed + struct.pack('<H', key_nonce >> 16))
    encrypted = compact_cipher_v5(bytes(payload), seconds, seed, substitution_tables)
    for group in range(31):
        for offset, source_bit in enumerate(SOURCE_BITS):
            index = group * 8 + offset
            bit = (encrypted[group] >> PACKED_BITS[offset]) & 1
            payload[index] = (payload[index] & ~(1 << source_bit)) | (bit << source_bit)
    header = struct.pack('<I', seconds ^ 5) + xor(frame, struct.pack('<I', seconds) * 4)
    result = header + struct.pack('<H', key_nonce & 65535) + b'\x00\x01' + encrypted[-1:] + payload
    return base64.b64encode(result).decode('ascii')
