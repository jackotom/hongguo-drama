"""Experimental anonymous playback framing bound to our own ready SDK session.

No transport, registration, account loading, or integration in existing playback.
"""
import gzip
import json
import re
import secrets
from urllib.parse import quote, urlencode
from phone_sdk_bootstrap_v5 import sign_prepared_v5

HOST = 'api5-normal-sinfonlineb.fqnovel.com'
PATH = '/novel/player/multi_video_model/player/v1'


def prepare_playback_v5(context, video, milliseconds, *, token, previous_ladon, materials, image, core):
    if not isinstance(context, dict) or not isinstance(context.get('params'), dict):
        raise ValueError('invalid-playback-context')
    cookies = context.get('cookies', {})
    if not isinstance(cookies, dict) or cookies.get('store-region-src') == 'uid':
        raise ValueError('anonymous-playback-required')
    if not isinstance(video, str) or not re.fullmatch(r'[1-9][0-9]{7,23}', video):
        raise ValueError('invalid-video-identity')
    if type(milliseconds) is not int or not 0 <= milliseconds // 1000 <= 0xffffffff:
        raise ValueError('invalid-playback-time')
    params = dict(context['params'])
    if params.get('aid') != '8662':
        raise ValueError('invalid-playback-application')
    for name in ('device_id', 'iid'):
        if not isinstance(params.get(name), str) or not re.fullmatch(r'[1-9][0-9]{4,29}', params[name]):
            raise ValueError('invalid-playback-identity')
    for name in ('cdid', 'device_type', 'device_brand', 'os_version', 'os_api', 'dpi', 'resolution'):
        value = params.get(name)
        if not isinstance(value, str) or not value or len(value) > 256 or any(ord(c) < 32 or ord(c) > 126 for c in value):
            raise ValueError('invalid-playback-profile')
    params.update(version_code='74332', version_name='7.4.3.32', update_version_code='74332',
                  manifest_version_code='74332', device_platform='android', os='android',
                  _rticket=str(milliseconds))
    names = ('device_platform os ssmix _rticket cdid channel aid app_name version_code version_name '
             'manifest_version_code update_version_code resolution dpi device_type device_brand '
             'language os_api os_version ac host_abi dragon_device_type pv_player compliance_status '
             'need_personal_recommend player_so_load is_android_pad_screen rom_version device_id iid klink_egdi').split()
    query = urlencode([(name, params[name]) for name in names if params.get(name)], quote_via=quote, safe='*').encode('ascii')
    # Existing app's media contract, preserving the one selected episode and
    # all model definitions. Final compressed bytes are signed exactly once.
    payload = {'dr_scene': 'player', 'mixed_video_id_map': {'1004': [video]}, 'biz_param': {
        'detail_page_version': 0, 'device_level': 4, 'disable_digg_stat': False,
        'need_all_video_definition': True, 'need_mp4_align': False, 'use_os_player': False,
        'use_server_dns': False, 'video_platform': 1024}}
    body = gzip.compress(json.dumps(payload, separators=(',', ':')).encode(), mtime=0)
    request = sign_prepared_v5(params, cookies, query, body, milliseconds, token=token,
        previous_ladon=previous_ladon, materials=materials, image=image, core=core,
        origin='https://' + HOST, path=PATH)
    request.headers.update({'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip',
        'Accept': 'application/json', 'X-Reading-Request': f'{milliseconds}-{100000000 + secrets.randbelow(900000000)}',
        'X-TT-Store-Region': cookies.get('store-region') or 'cn', 'X-TT-Store-Region-Src': 'did',
        'X-SS-REQ-TICKET': str(milliseconds)})
    return request
