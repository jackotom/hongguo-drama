"""Explicit author follow intent; independent contract, existing encrypted journal.

Status reads only the last local receipt, never invents current phone state.
No background writes, automatic retry, or returned login-cookie adoption.
"""
import hashlib,json,re,time,secrets
from urllib.parse import urlsplit
import requests
from phone_account_flow import AccountError
from phone_social_likes import LikeJournal
from phone_account_favorites import request_context,reading_minimal_headers
from phone_account_transport import region_headers
from phone_account_social import sign

HOST='api5-normal-lq.fqnovel.com'
PATH='/novel/commentapi/comment/do_action/v1/'
# User authorized manual author-follow / unfollow on this host and path.
# Only an explicit validated intent reaches wire(); no automatic live test.
WRITES_ENABLED=True

def journal_for(device_path):
    return LikeJournal(device_path,filename='account-author-follow.dpapi',value_key='following',label='关注')

def validate(request):
    if not isinstance(request,dict):raise AccountError('作者关注参数无效，尚未提交')
    action=request.get('action');keys={'action','authorId'}
    if action=='author_follow_change':keys|={'following','requestId','contextId'}
    elif action!='author_follow_status':raise AccountError('不支持的作者关注操作')
    if set(request)!=keys or not isinstance(request.get('authorId'),str) or not re.fullmatch(r'[1-9][0-9]{4,29}',request['authorId']):raise AccountError('作者标识无效，请刷新评论')
    if action=='author_follow_change' and (type(request['following']) is not bool or not isinstance(request['requestId'],str) or not re.fullmatch(r'[A-Za-z0-9-]{16,64}',request['requestId'])):raise AccountError('作者关注操作标识无效，尚未提交')
    if action=='author_follow_change' and (not isinstance(request['contextId'],str) or not re.fullmatch(r'[a-f0-9]{64}',request['contextId'])):raise AccountError('关注账号上下文无效，尚未提交')

def make_body(author,following):
    validate({'action':'author_follow_change','authorId':author,'following':following,'requestId':'contract-check-1234','contextId':'0'*64})
    return {'object_id':author,'object_type':1,'action_type':25 if following else 26,'aid':8662,
            'business_param':{'shark_param':{'enter_from':'ShortSeriesDetailActivity','previous_page':'MainFragmentActivity','page_list':'MainFragmentActivity,ShortSeriesDetailActivity'}}}

def public(author,can_follow,row=None,context_id=''):
    result={'authorId':author,'canFollow':can_follow,'writesEnabled':WRITES_ENABLED,'state':'unobserved','contextId':context_id}
    if row:result.update({k:row[k] for k in ('state','following','requestId')})
    return result

def parse_receipt(root,author):
    if not isinstance(root,dict):return 'unknown'
    code=root.get('code');data=root.get('data')
    if isinstance(data,dict):
        if data.get('object_id') is not None and str(data['object_id'])!=author:return 'unknown'
        if data.get('error_code') not in (None,0,'0'):code=data['error_code']
    if type(code) not in (int,str) or not re.fullmatch(r'-?[0-9]{1,6}',str(code)):return 'unknown'
    return 'accepted' if str(code)=='0' else 'rejected'

def wire(flow,author,following,before_send,client_factory=requests.Session):
    body=json.dumps(make_body(author,following),separators=(',',':')).encode()
    url,headers=sign(request_context(flow.transport.context),body,path=PATH)
    parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.path!=PATH or parsed.fragment or not parsed.query:raise AccountError('作者关注请求路由无效，尚未提交')
    url='https://'+HOST+PATH+'?'+parsed.query
    headers=reading_minimal_headers(headers)
    cookies={c.name:c.value for c in flow.transport.client.cookies};headers.update(region_headers(cookies))
    headers['X-Reading-Request']=str(int(time.time()*1000))+'-'+str(100000000+secrets.randbelow(900000000))
    if flow.transport.token:headers['X-TT-Token']=flow.transport.token
    if cookies.get('passport_csrf_token'):headers['X-TT-Passport-Csrf-Token']=cookies['passport_csrf_token']
    client=client_factory()
    try:
        client.trust_env=False;client.auth=None;client.cookies.clear();client.headers.clear()
        for name,value in cookies.items():client.cookies.set(name,value,domain=HOST,path='/')
        if client.get_adapter(url).max_retries.total!=0:raise AccountError('作者关注请求不允许自动重试')
        prepared=client.prepare_request(requests.Request('POST',url,headers=headers,data=body))
        if prepared.url!=url or prepared.body!=body:raise AccountError('作者关注请求编码变化，尚未发送')
        before_send();started=time.monotonic()
        with client.send(prepared,timeout=(8,20),allow_redirects=False,stream=True) as response:
            if response.status_code!=200:return 'unknown'
            chunks=[];size=0
            for chunk in response.iter_content(32768):
                size+=len(chunk)
                if size>2*1024*1024 or time.monotonic()-started>30:return 'unknown'
                chunks.append(chunk)
            return parse_receipt(json.loads(b''.join(chunks)),author)
    finally:client.close()

def handle(flow,request,device_path,*,journal_factory=journal_for,sender=wire):
    validate(request);author=request['authorId'];mutate=request['action']=='author_follow_change'
    if not flow.uid or not flow.transport.authenticated_cookies():raise AccountError('请先登录红果账号')
    if str(flow.uid)==author:
        if mutate:raise AccountError('不能关注自己，尚未提交')
        return public(author,False)
    context=flow.transport.context or {};params=context.get('params',{})
    if not params.get('device_id') or not params.get('iid'):raise AccountError('账号设备尚未就绪')
    key=hashlib.sha256(json.dumps([str(flow.uid),params['device_id'],params['iid'],author],separators=(',',':')).encode()).hexdigest()
    journal=journal_factory(device_path);rows=journal.read();previous=rows.get(key)
    if not mutate:return public(author,True,previous,key)
    if request['contextId']!=key:raise AccountError('登录账号已变化，请重新打开作者操作，尚未提交')
    if not WRITES_ENABLED:raise AccountError('作者关注尚未开放，尚未提交')
    if previous and previous['requestId']==request['requestId'] and previous['following']!=request['following']:raise AccountError('操作标识已使用，尚未提交')
    if previous and (previous['state']=='unknown' or previous['requestId']==request['requestId']):return public(author,True,previous,key)
    if key not in rows and len(rows)>=256:raise AccountError('作者关注记录已满，尚未提交')
    row={'state':'unknown','following':request['following'],'requestId':request['requestId']};sent=False
    def before_send():
        nonlocal sent
        rows[key]=dict(row);journal.write(rows);sent=True
    try:result=sender(flow,author,request['following'],before_send)
    except Exception:
        if not sent:raise AccountError('作者关注准备失败，尚未提交') from None
        result='unknown'
    if not sent:raise AccountError('作者关注尚未提交')
    if result not in ('accepted','rejected','unknown'):result='unknown'
    row['state']=result;rows[key]=row
    try:journal.write(rows)
    except Exception:row={**row,'state':'unknown'}
    return public(author,True,row,key)
