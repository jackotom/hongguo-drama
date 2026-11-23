"""Independent V5 playback wire primitive, not yet selected by live transport.

Validated against synthetic interoperability vectors. The existing Passport and
playback signers keep their defaults; this component alone is not a complete V5
request signature. ARC4 and the final transform reuse our attributed dependencies.
"""
import hashlib
import secrets
import struct

from Crypto.Cipher import ARC4
from vendor.XGorgon import XGorgon


def gorgon_v5(query: bytes, body: bytes, seconds: int, nonce: int | None = None, *, flags: bytes = bytes(2)) -> str:
    """Sign the exact encoded query/body with the V5 8404 frame."""
    if not isinstance(query, bytes) or not isinstance(body, bytes):
        raise ValueError('encoded-query-and-body-required')
    if type(seconds) is not int or not 0 <= seconds <= 0xffffffff:
        raise ValueError('invalid-signing-time')
    if nonce is None:
        nonce = secrets.randbelow(1 << 16)
    if type(nonce) is not int or not 0 <= nonce < 1 << 16:
        raise ValueError('invalid-signing-nonce')
    if not isinstance(flags, bytes) or len(flags) != 2:
        raise ValueError('invalid-signing-flags')
    query_hash = hashlib.md5(query).digest()[:4]
    body_hash = hashlib.md5(body).digest()[:4] if body else bytes(4)
    payload = query_hash + body_hash + bytes(4) + bytes.fromhex('00030a04') + struct.pack('>I', seconds)
    key = bytes((0x4a, flags[0], 0x16, nonce >> 8, 0x47, 0x6c, flags[1], nonce & 0xff))
    encrypted = ARC4.new(key).encrypt(payload)
    transformed = bytes(XGorgon()._XGorgon__handle(list(encrypted)))
    frame = bytes.fromhex('8404') + struct.pack('<H', nonce) + flags
    return (frame + transformed).hex()
