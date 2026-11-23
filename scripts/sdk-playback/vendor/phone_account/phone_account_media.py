"""Read one episode's media metadata with an existing account.

No login, registration, retry, profile persistence or adoption of response cookies.
Not installed or wired into the player until the account-read scope is approved.
"""
import gzip
import json
import re
import secrets
import time
from urllib.parse import urlencode
import requests
from phone_account_favorites import request_context
from phone_account_transport import region_headers
from desktop_video_model import parse_video_model

HOST='api5-normal-lq.fqnovel.com'
LEGACY_PATH='/novel/player/multi_video_model/v1/'
PATH='/novel/player/multi_video_model/player/v1'
LIMIT=2*1024*1024
FIELDS=frozenset('ac aid app_name cdid channel compliance_status device_brand device_id device_platform device_type dpi dragon_device_type host_abi iid is_android_pad_screen language manifest_version_code need_personal_recommend os os_api os_version player_so_load pv_player resolution ssmix update_version_code version_code version_name'.split())

class MediaReadError(ValueError):
    def __init__(self,reason,**numbers):
        self.reason=reason
        self.diagnostic={k:v for k,v in numbers.items() if k in ('http_status','body_bytes','code') and type(v) is int}
        super().__init__('账号播放地址暂不可用，请稍后重试')

def _prepare_unsigned(context,video,now_ms):
    if not isinstance(video,str) or not re.fullmatch(r'[1-9][0-9]{7,23}',video):
        raise MediaReadError('invalid-episode')
    if type(now_ms) is not int or not 946684800000<=now_ms<=4102444800000:
        raise MediaReadError('invalid-time')
    if not isinstance(context,dict) or not isinstance(context.get('params'),dict):
        raise MediaReadError('invalid-context')
    selected={k:str(v) for k,v in context['params'].items() if k in FIELDS and type(v) in (str,int)}
    if any(not re.fullmatch(r'[1-9][0-9]{4,29}',selected.get(k,'')) for k in ('device_id','iid')):
        raise MediaReadError('invalid-device')
    query=request_context({'params':selected,'cookies':{}})['params']
    query={k:str(v) for k,v in query.items() if k in FIELDS}
    query['_rticket']=str(now_ms)
    agent=context.get('user_agent')
    if not isinstance(agent,str) or not agent or '\r' in agent or '\n' in agent:
        raise MediaReadError('invalid-agent')
    headers={'User-Agent':agent,'Accept':'application/json','Content-Type':'application/json; charset=utf-8',
             'Content-Encoding':'gzip','X-Reading-Request':f'{now_ms}-{100000000+secrets.randbelow(900000000)}'}
    payload={'dr_scene':'player','mixed_video_id_map':{'1004':[video]},'biz_param':{
        'detail_page_version':0,'device_level':4,'disable_digg_stat':False,
        'need_all_video_definition':True,'need_mp4_align':False,'use_os_player':False,
        'use_server_dns':False,'video_platform':1024}}
    return 'https://'+HOST+PATH+'?'+urlencode(sorted(query.items())),headers,gzip.compress(json.dumps(payload,separators=(',',':')).encode(),mtime=0)


def prepare(context,video,now_ms):
    if not isinstance(context,dict) or not isinstance(context.get('params'),dict):
        raise MediaReadError('invalid-context')
    agent=context.get('user_agent')
    if not isinstance(agent,str) or not agent or '\r' in agent or '\n' in agent:
        raise MediaReadError('invalid-agent')
    from desktop_playback_request import prepare_account
    try:return prepare_account(context,video,now_ms)
    except MediaReadError:raise
    except (ValueError,TypeError,KeyError):raise MediaReadError('invalid-context') from None

def read_media(flow,video,*,client_factory=requests.Session,clock=time.monotonic):
    transport=flow.transport
    if not flow.uid or not transport.authenticated_cookies():raise MediaReadError('login-required')
    url,headers,body=prepare(transport.context,video,int(time.time()*1000))
    cookies={c.name:c.value for c in transport.client.cookies}
    headers.update(region_headers(cookies))
    if transport.token:headers['X-TT-Token']=transport.token
    if cookies.get('passport_csrf_token'):headers['X-TT-Passport-Csrf-Token']=cookies['passport_csrf_token']
    client=client_factory()
    try:
        # Do not inherit .netrc authentication. Use the existing app's network
        # settings explicitly, while keeping response cookies in this temporary jar.
        client.trust_env=False
        for name,value in cookies.items():client.cookies.set(name,value,domain=HOST,path='/')
        prepared=client.prepare_request(requests.Request('POST',url,data=body,headers=headers))
        if prepared.url!=url or prepared.body!=body:raise MediaReadError('encoding-changed')
        settings=transport.client.merge_environment_settings(url,{},None,None,None)
        if settings.get('verify') is False:raise MediaReadError('tls-verification-required')
        settings['stream']=True;started=clock()
        with client.send(prepared,timeout=(8,20),allow_redirects=False,**settings) as response:
            if response.status_code!=200:raise MediaReadError('upstream-http',http_status=response.status_code)
            chunks=[];size=0
            for chunk in response.iter_content(32768):
                size+=len(chunk)
                if size>LIMIT or clock()-started>45:raise MediaReadError('response-limit')
                chunks.append(chunk)
            if not size:raise MediaReadError('upstream-empty',http_status=200,body_bytes=0)
            root=json.loads(b''.join(chunks))
        if not isinstance(root,dict) or type(root.get('code')) is not int or root['code']!=0:
            raise MediaReadError('upstream-rejected',http_status=200,body_bytes=size,
                                 code=root.get('code') if isinstance(root,dict) else None)
        item=root.get('data',{}).get(video) if isinstance(root.get('data'),dict) else None
        if not isinstance(item,dict) or not isinstance(item.get('video_model'),(dict,str)) or not item['video_model']:
            raise MediaReadError('invalid-model')
        # Validate with our existing parser, without selecting a quality or changing
        # codec/encryption fields. Return no unrelated account response fields.
        result={'code':0,'data':{'video_model':item['video_model']}}
        try:parse_video_model(result)
        except ValueError:raise MediaReadError('invalid-model') from None
        return result
    except MediaReadError:raise
    except (requests.RequestException,ValueError,TypeError,KeyError):
        raise MediaReadError('transport-or-response') from None
    finally:client.close()
