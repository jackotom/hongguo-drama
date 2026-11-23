"""Manual single-series follow adapter, enabled for explicit user clicks.

Only the fixed route may receive a user intent. Every request uses a short-lived
client; response cookies/tokens never replace the existing account session.
"""
import json,time,secrets
from urllib.parse import urlsplit
import requests
from phone_following_actions import (PATH,FollowingError,FollowingJournal,make_body,
                                     validate,change,reconcile,public)
from phone_account_favorites import authenticated,request_context,reading_minimal_headers
from phone_account_transport import HOST as READ_HOST,ORIGIN,region_headers,signed_request
from phone_account_following import fetch_page,PATH as READ_PATH

WRITE_HOST='api5-normal-lq.fqnovel.com'
WRITES_ENABLED=True


def prepare(context,request,now_ms):
    from phone_account_social import sign
    if type(now_ms) is not int or not 946684800000<=now_ms<=4102444800000:
        raise FollowingError('系统时间异常，尚未提交追更。')
    body=json.dumps(make_body(request),ensure_ascii=False,separators=(',',':')).encode()
    url,headers=sign(request_context(context),body,now_ms=now_ms,path=PATH)
    parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.netloc!=urlsplit(ORIGIN).netloc or parsed.path!=PATH or not parsed.query or parsed.fragment:
        raise FollowingError('追更签名路由异常，尚未提交。')
    return 'https://'+WRITE_HOST+PATH+'?'+parsed.query,reading_minimal_headers(headers),body


def exchange(flow,method,url,headers,body=b'',client_factory=None):
    """One bounded request; never follows redirects, retries, or adopts cookies."""
    parsed=urlsplit(url)
    allowed=(method=='POST' and parsed.hostname==WRITE_HOST and parsed.path==PATH) or (method=='GET' and parsed.hostname==READ_HOST and parsed.path==READ_PATH)
    if not allowed or parsed.scheme!='https' or parsed.port not in (None,443) or parsed.username or parsed.password or parsed.fragment:
        raise FollowingError('追更请求目标无效，尚未发送。')
    cookies={cookie.name:cookie.value for cookie in flow.transport.client.cookies}
    headers={**headers,**region_headers(cookies)}
    headers['X-Reading-Request']=str(int(time.time()*1000))+'-'+str(100000000+secrets.randbelow(900000000))
    if flow.transport.token:headers['X-TT-Token']=flow.transport.token
    if cookies.get('passport_csrf_token'):headers['X-TT-Passport-Csrf-Token']=cookies['passport_csrf_token']
    client=(client_factory or requests.Session)()
    try:
        client.trust_env=False;client.auth=None;client.headers.clear();client.cookies.clear()
        for name,value in cookies.items():client.cookies.set(name,value,domain=parsed.hostname,path='/')
        if client.get_adapter(url).max_retries.total!=0:
            raise FollowingError('追更请求不允许自动重试。')
        prepared=client.prepare_request(requests.Request(method,url,data=body if method=='POST' else None,headers=headers))
        if prepared.url!=url or (prepared.body or b'')!=body:
            raise FollowingError('追更请求编码发生变化，尚未发送。')
        began=time.monotonic()
        with client.send(prepared,timeout=(8,20),allow_redirects=False,stream=True) as response:
            if response.status_code!=200:raise FollowingError('追更请求未完成，请核对手机状态。')
            chunks=[];size=0
            for chunk in response.iter_content(32768):
                size+=len(chunk)
                if size>2*1024*1024 or time.monotonic()-began>30:
                    raise FollowingError('追更响应未完整读取，请核对手机状态。')
                chunks.append(chunk)
            return json.loads(b''.join(chunks))
    finally:client.close()


def reader(flow,client_factory=None):
    def read(cursor):
        def fetch(path,query):
            url,body,headers=signed_request(flow.transport.context,path,extra=query,session=flow.transport.environment)
            return exchange(flow,'GET',url,headers,body,client_factory)
        return fetch_page(cursor,fetch)
    return read


def handle(flow,request,device_path,*,client_factory=None,journal_factory=FollowingJournal):
    action=request.get('action')
    allowed={'following_status':{'action'},'following_confirm':{'action','requestId'},
             'following_change':{'action','seriesId','following','requestId'}}
    if action not in allowed or set(request)!=allowed[action]:
        raise FollowingError('追更操作参数无效。')
    if action=='following_change':
        payload={key:value for key,value in request.items() if key!='action'}
        validate(payload)
        if not WRITES_ENABLED:raise FollowingError('手机追更管理尚未开放，原追更保持不变。')
    elif action=='following_confirm':
        validate({'seriesId':'12345678','following':False,'requestId':request['requestId']})
    account=authenticated(flow);journal=journal_factory(device_path)
    if action=='following_status':
        return {'writesEnabled':WRITES_ENABLED,'pending':[public(row) for row in journal.pending(account)]}
    if action=='following_confirm':
        return reconcile(account,request['requestId'],journal,reader(flow,client_factory))
    url,headers,body=prepare(flow.transport.context,payload,int(time.time()*1000))
    def send(_payload):return exchange(flow,'POST',url,headers,body,client_factory)
    def defer_read(_cursor):raise FollowingError('请单独读取确认追更状态。')
    # Separate confirmation bounds the POST's native pipe lifetime. Unknown
    # outcomes stay durable; a reopened control can only confirm, not replay.
    return change(account,payload,journal,send,defer_read,enabled=True)
