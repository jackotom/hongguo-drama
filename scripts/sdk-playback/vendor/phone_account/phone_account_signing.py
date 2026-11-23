"""Account wire-format adapters over attributed MIT and PyCryptodome primitives.

No network or credentials. These primitives alone do not constitute a complete
mainland Passport signer: the independently validated Medusa envelope is required.
"""
import base64
import hashlib
import secrets
import struct
from Crypto.Cipher import ARC4
from vendor.XGorgon import XGorgon
from vendor.XLadon import ladon_encrypt

AID = 8662
LICENSE_ID = 1588093228


def gorgon(query: bytes, body: bytes, seconds: int, nonce: int | None = None) -> str:
    """8404 frame. Sign the exact encoded query/body that will be transmitted."""
    nonce = secrets.randbelow(65536) if nonce is None else nonce
    if not 0 <= nonce <= 65535 or not 0 <= seconds <= 0xffffffff:
        raise ValueError('invalid-signing-time-or-nonce')
    payload = (hashlib.md5(query).digest()[:4] +
               (hashlib.md5(body).digest()[:4] if body else bytes(4)) +
               bytes(4) + bytes.fromhex('00040604') + struct.pack('>I', seconds))
    key = bytes((0x4a, 0x40, 0x16, nonce >> 8, 0x47, 0x6c, 1, nonce & 255))
    stream = ARC4.new(key).encrypt(payload)
    # Reuse the MIT dependency's byte transform, not its incompatible 0404 KSA.
    transformed = bytes(XGorgon()._XGorgon__handle(list(stream)))
    return (b'\x84\x04' + struct.pack('<H', nonce) + b'\x40\x01' + transformed).hex()


def helios(seconds: int, nonce: bytes | None = None) -> str:
    nonce = secrets.token_bytes(4) if nonce is None else nonce
    if len(nonce) != 4 or not 0 <= seconds <= 0xffffffff:
        raise ValueError('invalid-signing-time-or-nonce')
    # Explicit nonce avoids the upstream function's import-time default random.
    return ladon_encrypt(seconds, LICENSE_ID, AID, random_bytes=nonce)


def passport_components(query: bytes, body: bytes, seconds: int) -> dict[str, str]:
    """Return validated components; caller must add a validated Medusa signature."""
    values = {'X-Gorgon': gorgon(query, body, seconds), 'X-Helios': helios(seconds),
              'X-Khronos': str(seconds),
              'X-Argus': base64.b64encode(struct.pack('<I', seconds)).decode(),
              'X-Ladon': base64.b64encode(struct.pack('>I', seconds)).decode()}
    if body:
        values['X-SS-STUB'] = hashlib.md5(body).hexdigest().upper()
    return values
