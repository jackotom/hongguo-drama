"""V5 digest framing with an explicit, separately verified digest core.

The core owns the 16-byte SDK digest; this module owns the exact request binding
and trailer. No SDK executable/image, network call or fallback digest is bundled.
"""
import hashlib
import struct

from phone_account_medusa_digest import checksum, selector


def digest_v5(query, body, seconds, *, core):
    if not isinstance(query, bytes) or len(query) > 1024 * 1024:
        raise ValueError('invalid-query-bytes')
    if not isinstance(body, bytes) or len(body) > 16 * 1024 * 1024:
        raise ValueError('invalid-body-bytes')
    if type(seconds) is not int or not 0 <= seconds <= 0xffffffff:
        raise ValueError('invalid-signing-time')
    if not callable(core):
        raise ValueError('verified-sdk-core-required')
    query_hash = hashlib.new('sm3', query).digest()
    body_hash = hashlib.md5(body).digest() if body else bytes(16)
    mode = selector(query_hash, body_hash, seconds) & 15
    payload = query_hash + body_hash + struct.pack('<I', seconds)
    prefix = core(payload, mode, seconds)
    if not isinstance(prefix, bytes) or len(prefix) != 16:
        raise ValueError('invalid-sdk-core-result')
    return prefix + struct.pack('<I', checksum(prefix) | 0x20)
