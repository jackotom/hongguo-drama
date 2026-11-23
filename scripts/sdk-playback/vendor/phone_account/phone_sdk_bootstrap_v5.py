"""Prepare one anonymous SDK bootstrap request from this app's saved device.

Independent request assembly from observed protocol fields. Transport, retries,
account loading and session persistence are deliberately owned by the caller.
"""
import base64
from dataclasses import dataclass, field
import hashlib
import json
import os
import re
import secrets
import struct
from urllib.parse import quote, urlencode

from phone_account_medusa import device_proof, protobuf
from phone_playback_digest_v5 import digest_v5
from phone_playback_medusa_v5 import envelope_v5
from phone_playback_signing_v5 import gorgon_v5
from phone_sdk_exchange_v5 import exchange_request
from phone_sdk_materials_v5 import wire_fields
from vendor.XLadon import ladon_encrypt

ORIGIN = 'https://mssdk.zijieapi.com'
PATH = '/sdi/get_token'
SDK_VERSION = 'v04.10.03-ml-android'
SDK_CODE = 0x040a0300


@dataclass(frozen=True)
class PreparedBootstrap:
    url: str = field(repr=False)
    headers: dict = field(repr=False)
    body: bytes = field(repr=False)
    next_ladon: int


def signed(value):
    return (value << 1) ^ (value >> 63)


def device_payload(params, marker, token):
    # The unsupported-property sentinel is the protocol's explicit unknown
    # value. Never fill these properties from another device or host account.
    strings = [1, 19, 20, 23, 28, 31, 32, 38, 39, 50, 53, 93, 94, 95, 96,
               109, 110, 111, 115, 135, 2000, 2001]
    numbers = [13, 29, 30, 36, 37, 41, 42, 43, 49, 51, 52, 56, 57, 58, 59,
               60, 61, 62, 63, 64, 66, 67, 69, 70, 71, 72, 73, 74, 75, 76,
               77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 97, 98, 99,
               100, 101, 102, 103, 104, 105, 106, 113, 114, 116, 117, 118]
    values = {index: marker for index in strings}
    values.update({index: signed(-999999) for index in numbers})
    for index, key in [(2, 'device_brand'), (3, 'device_type'), (6, 'os_version'),
                       (7, 'resolution'), (9, 'rom_version')]:
        values[index] = params.get(key) or marker
    values.update({5: 'Android', 12: 'Asia/Shanghai,8'})
    for index, key in [(8, 'dpi'), (48, 'os_api')]:
        raw = params.get(key, '')
        values[index] = signed(int(raw)) if raw.isdigit() else signed(-999999)
    fields = [(1, protobuf(sorted(values.items()))), (3, 'android'), (4, SDK_VERSION),
              (5, signed(SDK_CODE)), (6, params['aid']), (7, params['version_name']),
              (8, params['device_id']), (11, signed(-999999)), (16, signed(-999999)), (17, marker)]
    if token is not None:
        fields.insert(1, (2, token))
    return protobuf(fields)


def bound_device_proof(params):
    replacements = {3: params['aid'], 4: params['device_id'], 5: params['cdid'],
                    22: params['os_version'], 30: params['device_type'],
                    31: params['device_brand'], 32: params['device_type'],
                    33: params['device_type'], 34: params['device_brand'],
                    35: params['device_brand'], 36: params['device_brand']}
    # Reuse the validated existing device schema; bind all known descriptive
    # fields and the installation identity to the current registered profile.
    fields = []
    for number, encoding, value in wire_fields(device_proof(params['device_id'])):
        if number in replacements:
            value = replacements[number]
        elif encoding == 5:
            value = struct.unpack('<f', value)[0]
        fields.append((number, value))
    return protobuf(fields)


def advance_ladon(previous, allocation, seconds):
    if type(previous) is not int or not 0 <= previous <= 0xffffffff:
        raise ValueError('invalid-sdk-ladon-state')
    checksum = 0
    for byte in b'646637794':
        checksum ^= byte
        for _ in range(8):
            checksum = (checksum >> 1) ^ (0x95ac9329ac4bc9b5 if checksum & 1 else 0)
    mixed = allocation ^ checksum ^ seconds
    rotated = ((mixed << 4) | (mixed >> 60)) & ((1 << 64) - 1)
    return previous ^ (rotated & 0xffffffff)


def prepare_bootstrap(context, milliseconds, *, materials, image, core, token=None, previous_ladon=0):
    if not isinstance(context, dict) or not isinstance(context.get('params'), dict):
        raise ValueError('saved-anonymous-device-required')
    cookies = context.get('cookies', {})
    if not isinstance(cookies, dict) or cookies.get('store-region-src') == 'uid':
        raise ValueError('account-context-not-supported')
    if type(milliseconds) is not int or not 0 <= milliseconds < 1 << 63 or milliseconds // 1000 > 0xffffffff:
        raise ValueError('invalid-sdk-bootstrap-time')
    if token is not None and (not isinstance(token, str) or not 1 <= len(token) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in token)):
        raise ValueError('invalid-own-sdk-session')
    params = dict(context['params'])
    for key in ('device_id', 'iid'):
        if not isinstance(params.get(key), str) or not re.fullmatch(r'[1-9][0-9]{4,29}', params[key]):
            raise ValueError('invalid-saved-device-identity')
    if params.get('aid') != '8662':
        raise ValueError('unsupported-sdk-application')
    for key in ('cdid', 'device_type', 'device_brand', 'os_version', 'os_api', 'resolution', 'dpi'):
        if not isinstance(params.get(key), str) or not params[key] or len(params[key]) > 256:
            raise ValueError('incomplete-saved-device-profile')
    if any(not isinstance(value, str) or any(ord(c) < 32 or ord(c) > 126 for c in value)
           for value in params.values()):
        raise ValueError('invalid-saved-device-profile')
    params.update(version_name='7.4.3.32', version_code='74332', manifest_version_code='74332',
                  update_version_code='74332', device_platform='android', os='android')
    fields = [('lc_id', '646637794'), ('platform', 'android'), ('device_platform', 'android'),
              ('sdk_ver', SDK_VERSION), ('sdk_ver_code', str(SDK_CODE)), ('app_ver', params['version_name']),
              ('version_code', params['version_code']), ('aid', params['aid']), ('sdkid', params.get('sdkid', '')),
              ('subaid', params.get('subaid', '')), ('iid', params['iid']), ('did', params['device_id']),
              ('bd_did', params.get('bd_did', '')), ('client_type', 'inhouse'), ('region_type', 'ml'),
              ('mode', '2'), ('full_update_version_code', params['update_version_code'])]
    for key in ('os', 'ssmix', '_rticket', 'cdid', 'channel', 'app_name', 'version_name',
                'manifest_version_code', 'update_version_code', 'resolution', 'dpi', 'device_type',
                'device_brand', 'language', 'os_api', 'os_version', 'ac', 'host_abi', 'dragon_device_type',
                'pv_player', 'compliance_status', 'need_personal_recommend', 'player_so_load',
                'is_android_pad_screen', 'rom_version', 'device_id', 'klink_egdi'):
        value = str(milliseconds) if key == '_rticket' else ('1' if key == 'need_personal_recommend' else params.get(key, ''))
        fields.append((key, value))
    query = urlencode(fields, quote_via=quote, safe='*').encode('ascii')
    plaintext = device_payload(params, image.unavailable, token)
    body = exchange_request(plaintext, milliseconds, common=materials.exchange_key,
                            inner=image.exchange_inner_key, nonce=secrets.token_bytes(4), entropy_byte=secrets.randbits(8))
    return sign_prepared_v5(params, cookies, query, body, milliseconds, materials=materials,
                           image=image, core=core, token=token, previous_ladon=previous_ladon,
                           origin=ORIGIN, path=PATH, bootstrap=True)


def sign_prepared_v5(params, cookies, query, body, milliseconds, *, materials, image,
                     core, token, previous_ladon, origin, path, bootstrap=False):
    """Sign final bytes; callers validate their input and own transport scope."""
    if not bootstrap and (not isinstance(token, str) or not 1 <= len(token) <= 256
                          or any(ord(c) < 33 or ord(c) > 126 for c in token)):
        raise ValueError('own-sdk-session-required')
    if (origin, path, bootstrap) not in (
            (ORIGIN, PATH, True),
            ('https://api5-normal-sinfonlineb.fqnovel.com', '/novel/player/multi_video_model/player/v1', False)):
        raise ValueError('unsupported-v5-experiment-route')
    seconds = milliseconds // 1000
    proof = digest_v5(query, body, seconds, core=core)
    # SDK v04.10.03 normal playback uses the 0x0504 request context; the
    # reference desktop envelope's 0x8000 is a separate compatibility profile.
    prefix = struct.pack('<Q', 2 if bootstrap else 0x0504)
    counters = protobuf([(1, 2), (2, 1388734), (3, 1388734), (5, 1388734)])
    environment = protobuf([(1, 2), (6, 'v04.10.03.04-bugfix'), (7, os.getpid() * 2),
        (8, params.get('channel', '')), (12, bound_device_proof(params)),
        (14, params['version_name']), (15, 4228), (19, milliseconds * 2)])
    state = json.dumps({'cmr': 16777216, 'cmr2': 16777216, 'vpn': 0,
                        'kd': 0, 'dyn': '', 'do': 0, 'tk': token is not None}, separators=(',', ':'))
    nonce = [secrets.randbits(32) for _ in range(3)]
    message = protobuf([(1, image.frame), (2, 10), (3, nonce[0] * 2), (4, '8662'),
        (5, params['device_id']), (6, '646637794'), (7, params['version_name']),
        (8, SDK_VERSION), (9, SDK_CODE * 2), (10, prefix), (12, seconds * 2),
        (13, proof), (14, hashlib.new('sm3', query).digest()[:6]), (15, counters),
        (16, token or ''), (17, seconds * 2), (20, 'none'), (21, 738), (23, environment), (24, state)])
    medusa = envelope_v5(message, hashlib.new('sm3', query).digest(), proof, seconds, nonce[1], nonce[2],
        seed=materials.signing_key, frame=image.frame, prefix=prefix, substitution_tables=image.substitutions)
    next_ladon = advance_ladon(previous_ladon, secrets.randbits(64) & ~15, seconds)
    headers = {'Content-Type': 'application/octet-stream', 'Accept': '*/*',
        'X-TT-Request-Tag': 't=0;n=0', 'X-SS-DP': '8662', 'X-Khronos': str(seconds),
        'X-Argus': base64.b64encode(struct.pack('<I', seconds)).decode(),
        'X-Ladon': base64.b64encode(struct.pack('>I', next_ladon)).decode(),
        'X-Gorgon': gorgon_v5(query, body, seconds, flags=prefix[:2]),
        'X-Helios': ladon_encrypt(seconds, 646637794, 8662, random_bytes=secrets.token_bytes(4)),
        'X-Medusa': medusa, 'X-SS-STUB': hashlib.md5(body).hexdigest().upper(),
        'X-VC-Bdturing-SDK-Version': '4.0.3.cn',
        'X-TT-Trace-ID': f'00-{secrets.token_hex(16)}-{secrets.token_hex(8)}-01'}
    headers['User-Agent'] = (f"com.phoenix.read/74332 (Linux; U; Android {params['os_version']}; zh_CN; "
                             f"{params['device_type']}; Cronet/TTNetVersion:8d40f833_2026-03-03)")
    selected = {'install_id': params['iid']}
    for name in ('odin_tt', 'ttreq', 'store-region'):
        value = cookies.get(name)
        if value:
            if not isinstance(value, str) or len(value) > 8192 or re.search(r'[\x00-\x20;\x7f-\uffff]', value):
                raise ValueError('invalid-anonymous-cookie')
            selected[name] = value
    selected['store-region-src'] = 'did'
    headers['Cookie'] = '; '.join(f'{key}={value}' for key, value in selected.items())
    return PreparedBootstrap(origin + path + '?' + query.decode('ascii'), headers, body, next_ladon)
