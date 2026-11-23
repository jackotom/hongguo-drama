"""Isolated signed account transport. No automatic retry, SMS or registration."""
import hashlib
import json
import re
import secrets
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

import requests

from phone_account_device import load_context, MAX_RESPONSE
from phone_account_flow import AccountError, SEND, LOGIN, VERIFY, USER
from phone_account_signing import passport_components
from phone_account_medusa import medusa
from phone_account_medusa_digest import selector
from phone_account_diagnostics import AccountDiagnostics

ORIGIN='https://api5-normal-sinfonlineb.fqnovel.com'
HOST='api5-normal-sinfonlineb.fqnovel.com'
FAVORITES_PATH='/reading/bookapi/bookshelf/video/list/v'
FAVORITES_HOST='api5-normal-lq.fqnovel.com'
LIBRARY={'/reading/bookapi/bookshelf/video/list/v','/reading/bookapi/read_history/list/v',
         '/novel/articleapi/relation/get_user_action/v1/'}

# Account requests have a distinct wire contract from device registration. Keep
# registration-only identifiers out of Passport, and never put phone/OTP in URLs.
ACCOUNT_FIELDS = frozenset('iid device_id ac channel aid app_name version_code version_name device_platform os ssmix device_type device_brand language os_api os_version manifest_version_code resolution dpi update_version_code host_abi dragon_device_type pv_player compliance_status need_personal_recommend player_so_load is_android_pad_screen rom_version cdid'.split())
SDK_QUERY = {'passport-sdk-version': '5051452', 'use_new_token_expire_rule': 'true',
             'cronet_version': '8d40f833_2026-03-03', 'ttnet_version': '4.2.243.31-douyin',
             'use_store_region_cookie': '1'}
ACCOUNT_DEFAULTS = {'dragon_device_type': 'phone', 'compliance_status': '0',
                    'player_so_load': '1', 'is_android_pad_screen': '0'}


def region_headers(cookies):
    """Use this session's server-issued routing metadata, never a guessed region."""
    region = cookies.get('store-region')
    if not isinstance(region, str) or not re.fullmatch(r'[a-z]{2}(?:-[a-z0-9]{1,10})?', region):
        return {}
    result = {'X-TT-Store-Region': region}
    source = cookies.get('store-region-src')
    if source in ('did', 'uid'):
        result['X-TT-Store-Region-Src'] = source
    return result


def account_payload(context, path, form, session, ticket):
    """Independent Passport serialization; both copies share the same identity.

    Send/login carry app parameters in both query and form, except query-only
    SDK metadata. Verification carries only its explicit verification form.
    Session identifiers describe our own process; no synthetic usage counters,
    mobile telemetry or another client's identity is imported.
    """
    app = {key: str(value) for key, value in context['params'].items() if key in ACCOUNT_FIELDS}
    for key, value in ACCOUNT_DEFAULTS.items():
        app.setdefault(key, value)
    if 'version_code' in app:
        app.setdefault('pv_player', app['version_code'])
    app['_rticket'] = str(ticket)
    query = {**app, **SDK_QUERY}
    if path in {SEND, LOGIN}:
        fields = {**app, **(session or {}), **form}
    else:
        fields = dict(form)
    return query, urlencode(sorted(fields.items())).encode()


def signed_request(context,path,form=None,extra=None,now_ms=None,session=None):
    if path not in {SEND,LOGIN,VERIFY,USER}|LIBRARY:raise AccountError('不支持的账号操作')
    if (path in {SEND,LOGIN,VERIFY}) != (form is not None):raise AccountError('账号请求方式无效')
    params={str(k):str(v) for k,v in context['params'].items()}
    for key in ('tt_data',):params.pop(key,None)
    passport = path in {SEND, LOGIN, VERIFY}
    if passport and extra:
        raise AccountError('账号登录不接受额外查询参数')
    if extra:params.update({str(k):str(v) for k,v in extra.items()})
    ms=int(time.time()*1000) if now_ms is None else now_ms
    seconds=ms//1000
    params['ts']=str(seconds)
    body=urlencode(sorted(form.items())).encode() if form is not None else b''
    # A bounded choice of the request's millisecond nonce selects the independently
    # implemented digest variant. All signatures bind to exactly this final URL.
    for offset in range(256):
        if passport:
            params, body = account_payload(context, path, form, session, ms+offset)
        else:
            params['_rticket']=str(ms+offset)
        bd=hashlib.md5(body).digest() if body else bytes(16)
        query=urlencode(sorted(params.items())).encode()
        if (selector(hashlib.new('sm3',query).digest(),bd,seconds)&15)%3==2:break
    else:raise AccountError('账号签名准备失败，请稍后重试')
    headers=passport_components(query,body,seconds)
    headers['X-Medusa']=medusa(query,body,seconds,params['device_id'])
    headers.update({'User-Agent':context['user_agent'],'Accept':'application/json; charset=utf-8,application/x-protobuf',
        'Accept-Encoding':'gzip','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
        'X-SS-DP':'8662','X-SS-REQ-TICKET':params['_rticket'],'X-TT-Request-Tag':'t=0;n=1',
        'X-TT-Trace-Id':'00-'+secrets.token_hex(16)+'-'+secrets.token_hex(8)+'-01',
        'Passport-SDK-Version':'5051452','Sdk-Version':'2','X-XS-From-Web':'0',
        'X-VC-Bdturing-SDK-Version':'4.0.3.cn','lc':'101',
        'X-TT-Store-Region':'cn','X-TT-Store-Region-Src':'did'})
    headers.update(region_headers(context.get('cookies',{})))
    return ORIGIN+path+'?'+query.decode(),body,headers


class AccountTransport:
    def __init__(self,device_path,client_factory=requests.Session):
        root=Path(__file__).resolve().parent
        for name,expected in json.loads((root/'protocol-integrity.json').read_text()).items():
            if hashlib.sha256((root/name).read_bytes()).hexdigest()!=expected:
                raise AccountError('账号签名组件校验失败')
        self.context=load_context(Path(device_path))
        self.diagnostics=AccountDiagnostics(Path(device_path).parent)
        self.factory=client_factory
        self.client=None;self.token=''
        # One environment across send, OTP login and any accepted continuation.
        # Resetting cookies does not pretend that the application cold-started.
        self.environment={'normal_session_id':str(uuid.uuid4()),
                          'cold_start_session_id':str(uuid.uuid4())}
        self.reset()

    def ready(self):
        if self.context is None:raise AccountError('独立账号设备尚未准备好，请联系维护者检查候选版')
        if self.context['params'].get('aid')!='8662':raise AccountError('账号设备配置不匹配')

    def reset(self):
        if self.client:self.client.close()
        self.client=self.factory()
        self.token=''
        if self.context:
            for name,value in self.context.get('cookies',{}).items():
                self.client.cookies.set(name,value,domain=HOST,path='/')
        csrf=secrets.token_hex(16)
        for name in ('passport_csrf_token','passport_csrf_token_default'):
            self.client.cookies.set(name,csrf,domain=HOST,path='/')

    def authenticated_cookies(self):
        return bool(self.token or any(c.name in {'sessionid','sessionid_ss','sid_tt'} and c.value for c in self.client.cookies))

    def request(self,path,form=None,extra=None):
        self.ready()
        if path == FAVORITES_PATH:
            if form is not None: raise AccountError('手机收藏只支持读取')
            return self.read_favorites(extra)
        url,body,headers=signed_request(self.context,path,form,extra,session=self.environment)
        # A response can update routing metadata during the OTP flow. Bind the
        # next request's headers to the same live cookie jar that sends it.
        headers.update(region_headers({cookie.name:cookie.value for cookie in self.client.cookies}))
        if self.token:headers['X-TT-Token']=self.token
        csrf=next((c.value for c in self.client.cookies if c.name=='passport_csrf_token'),None)
        if csrf:headers['X-TT-Passport-Csrf-Token']=csrf
        try:
            # Requests has no POST retries by default; redirects are explicitly off.
            prepared=self.client.prepare_request(requests.Request('POST' if form is not None else 'GET',url,
                data=body if form is not None else None,headers=headers))
            if prepared.url!=url or (prepared.body or b'')!=body:raise AccountError('账号请求编码发生变化，已停止发送')
            settings=self.client.merge_environment_settings(url,{},None,None,None)
            settings['stream']=True
            with self.client.send(prepared,timeout=(8,20),allow_redirects=False,**settings) as response:
                if response.status_code!=200:raise AccountError('账号服务暂不可用，请稍后重试')
                chunks=[];size=0
                for chunk in response.iter_content(32768):
                    size+=len(chunk)
                    if size>MAX_RESPONSE:raise AccountError('账号响应过大，已停止接收')
                    chunks.append(chunk)
                root=json.loads(b''.join(chunks))
                if not isinstance(root,dict):raise AccountError('账号响应格式异常')
                self.diagnostics.record(path,root)
                token=response.headers.get('x-tt-token','')
                if token and len(token)<=8192:self.token=token
                # Normalize by name after accepting the complete response. This
                # prevents a fresh parent-domain CSRF cookie coexisting with an
                # older host-only seed and producing an ambiguous Cookie header.
                cookies={c.name:c.value for c in self.client.cookies}
                cookies.update({c.name:c.value for c in response.cookies})
                if len(cookies)>80 or any(len(k)>128 or len(v)>8192 for k,v in cookies.items()):
                    raise AccountError('账号会话响应异常')
                self.client.cookies.clear()
                for name,value in cookies.items():
                    if value:self.client.cookies.set(name,value,domain=HOST,path='/')
                return root
        except AccountError:raise
        except requests.Timeout:raise AccountError('账号请求超时，结果尚未确认；请勿连续重复发送') from None
        except requests.RequestException:raise AccountError('账号服务连接失败，请稍后重试') from None
        except (ValueError,TypeError):raise AccountError('账号服务返回了无法识别的内容') from None

    def read_favorites(self, extra=None):
        """Explicitly scoped read origin; its response never replaces login state."""
        url,body,headers=signed_request(self.context,FAVORITES_PATH,extra=extra,session=self.environment)
        prefix=ORIGIN+FAVORITES_PATH+'?'
        if body or not url.startswith(prefix): raise AccountError('手机收藏请求格式异常')
        url='https://'+FAVORITES_HOST+FAVORITES_PATH+'?'+url[len(prefix):]
        # Copy the current authentication into an ephemeral jar for this one
        # fixed GET route. Do not broaden HOST or trust returned session cookies.
        client=self.factory()
        client.trust_env=False
        try:
            cookies={cookie.name:cookie.value for cookie in self.client.cookies}
            headers.update(region_headers(cookies))
            if self.token: headers['X-TT-Token']=self.token
            if cookies.get('passport_csrf_token'): headers['X-TT-Passport-Csrf-Token']=cookies['passport_csrf_token']
            for name,value in cookies.items(): client.cookies.set(name,value,domain=FAVORITES_HOST,path='/')
            prepared=client.prepare_request(requests.Request('GET',url,headers=headers))
            if prepared.url!=url or prepared.body is not None: raise AccountError('手机收藏请求编码发生变化，已停止读取')
            started=time.monotonic()
            with client.send(prepared,timeout=(8,20),allow_redirects=False,stream=True) as response:
                if response.status_code!=200: raise AccountError('手机收藏暂时无法读取，请稍后重试')
                chunks=[];size=0
                for chunk in response.iter_content(32768):
                    size+=len(chunk)
                    if size>MAX_RESPONSE or time.monotonic()-started>45: raise AccountError('手机收藏响应超出限制，请稍后重试')
                    chunks.append(chunk)
                root=json.loads(b''.join(chunks))
                if not isinstance(root,dict): raise AccountError('手机收藏响应格式异常')
                self.diagnostics.record(FAVORITES_PATH,root)
                return root
        except AccountError: raise
        except requests.Timeout: raise AccountError('手机收藏读取超时，请稍后手动重试') from None
        except requests.RequestException: raise AccountError('手机收藏连接失败，请稍后手动重试') from None
        except (ValueError,TypeError): raise AccountError('手机收藏返回了无法识别的内容') from None
        finally: client.close()
