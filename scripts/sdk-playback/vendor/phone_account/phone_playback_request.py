"""Playback-specific request preparation; never alters saved login identity."""
import copy
import gzip
import hashlib
import io
import json
import secrets
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit
from phone_account_medusa import medusa
from phone_account_medusa_digest import selector
from phone_account_signing import passport_components


def prepare_playback(context, video, now_ms, unsigned):
    scoped = copy.deepcopy(context)
    scoped['params'].update(version_name='7.1.3.32',version_code='71332',update_version_code='71332',
        manifest_version_code='71332',pv_player='71332',channel='update_64',device_brand='Redmi',
        device_type='25053RT47C',os_version='16',os_api='36',resolution='1280*2772',dpi='520')
    scoped['user_agent']='com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)'
    url, headers, original = unsigned(scoped,video,now_ms)
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream,mode='wb',compresslevel=6,mtime=0) as compressor:
        compressor.write(json.dumps(json.loads(gzip.decompress(original)),sort_keys=True,separators=(',',':')).encode())
    body=stream.getvalue();parts=urlsplit(url);params=dict(parse_qsl(parts.query,keep_blank_values=True))
    # Registration correlation belongs to the login flow, not playback requests.
    params.pop('cdid',None);params['iid']='';seconds=now_ms//1000
    for delta in range(256):
        params['_rticket']=str(now_ms+delta)
        query=urlencode(sorted(params.items()),quote_via=quote,safe="-_.!~*'()").encode()
        if (selector(hashlib.new('sm3',query).digest(),hashlib.md5(body).digest(),seconds)&15)%3==2:break
    else:raise ValueError('playback-signature-unavailable')
    headers.update({'Accept':'application/json; charset=utf-8,application/x-protobuf','X-Xs-From-Web':'0',
        'X-Vc-Bdturing-Sdk-Version':'4.0.3.cn','Lc':'101','Sdk-Version':'2','Passport-Sdk-Version':'5051452',
        'X-SS-DP':str(params.get('aid','8662')),'X-SS-REQ-TICKET':str(now_ms)})
    headers.update(passport_components(query,body,seconds))
    headers['X-Medusa']=medusa(query,body,seconds,params['device_id'],version_name='7.1.3.32')
    trace=f'{now_ms&0xffffffff:08x}10{secrets.token_hex(8)}'
    headers['X-TT-Trace-ID']=f'00-{trace}-{trace[:16]}-01'
    return urlunsplit((parts.scheme,parts.netloc,parts.path,query.decode(),'')),headers,body
