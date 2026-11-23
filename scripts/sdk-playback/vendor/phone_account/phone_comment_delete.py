"""Explicit deletion of an author's own public content; no automatic replay."""
import hashlib,json,re,time
from pathlib import Path
from urllib.parse import urlsplit
import requests
from phone_account_flow import AccountError
from phone_account_session import SessionStore,protect
from phone_account_transport import HOST,ORIGIN,region_headers
from phone_account_favorites import request_context,reading_minimal_headers

PATH='/novel/commentapi/comment/del/v1/'
KINDS={'comments':(4,4),'replies':(4,9),'danmaku':(20,4),'reviews':(2,4),'review-replies':(2,9)}
STATES=('accepted','rejected','unknown')

def validate(request):
    if not isinstance(request,dict):raise AccountError('评论管理参数无效')
    fields={'action','kind','seriesId','commentId','authorId'}
    if request.get('action')=='comment_delete':fields.add('requestId')
    elif request.get('action')!='comment_delete_status':raise AccountError('不支持的评论管理操作')
    if set(request)!=fields or request.get('kind') not in KINDS:raise AccountError('评论管理参数无效')
    for key,minimum in [('seriesId',8),('commentId',5),('authorId',5)]:
        value=request.get(key)
        if not isinstance(value,str) or not re.fullmatch(r'[1-9][0-9]{'+str(minimum-1)+r',29}',value):raise AccountError('评论对象无效，请刷新列表')
    if 'requestId' in fields and (not isinstance(request['requestId'],str) or not re.fullmatch(r'[A-Za-z0-9-]{16,64}',request['requestId'])):raise AccountError('删除操作标识无效')

def make_body(request):
    validate(request)
    service,data=KINDS[request['kind']]
    body={'comment_id':request['commentId'],'service_id':service,'data_type':data}
    if request['kind']=='danmaku':body['aid']=8662
    return body

class DeleteJournal:
    def __init__(self,device_path,crypt=protect):
        self.path=Path(device_path).with_name('account-comment-deletes.dpapi');self.crypt=crypt
    def safe_path(self):
        for p in (self.path,self.path.with_suffix('.tmp')):
            if p.is_symlink() or (p.exists() and p.stat().st_nlink!=1):raise AccountError('评论操作记录路径异常，尚未发送')
    def read(self):
        try:
            self.safe_path()
            if not self.path.exists():return {}
            if self.path.stat().st_size>512000:raise ValueError()
            value=json.loads(self.crypt(self.path.read_bytes(),decrypt=True))
            if set(value)!={'version','rows'} or type(value['version']) is not int or value['version']!=1 or not isinstance(value['rows'],dict) or len(value['rows'])>256:raise ValueError()
            for key,row in value['rows'].items():
                if not re.fullmatch(r'[0-9a-f]{64}',key) or not isinstance(row,dict) or set(row)!={'state','requestId'} or row['state'] not in STATES or not isinstance(row['requestId'],str) or not re.fullmatch(r'[A-Za-z0-9-]{16,64}',row['requestId']):raise ValueError()
            return value['rows']
        except Exception:raise AccountError('无法读取评论操作记录，未发送删除') from None
    def write(self,rows):
        self.safe_path()
        if len(rows)>256:raise AccountError('评论操作记录已满，未发送删除')
        store=SessionStore(self.path,crypt=self.crypt);store.path=self.path
        try:store.write({'version':1,'rows':rows},limit=500000)
        except Exception:raise AccountError('无法保存评论操作记录，未自动重试') from None

def public(request,can_delete,row=None):
    return {k:request[k] for k in ('kind','seriesId','commentId')}|{'canDelete':can_delete,'state':row['state'] if row else 'unobserved',**({'requestId':row['requestId']} if row else {})}

def parse_receipt(root,comment_id):
    if not isinstance(root,dict):return 'unknown'
    code=root.get('code');data=root.get('data')
    if isinstance(data,dict):
        if data.get('comment_id') is not None and str(data['comment_id'])!=comment_id:return 'unknown'
        if data.get('error_code') not in (None,0,'0'):code=data['error_code']
    if type(code) not in (int,str) or not re.fullmatch(r'-?[0-9]{1,6}',str(code)):return 'unknown'
    return 'accepted' if str(code)=='0' else 'rejected'

def wire(flow,request,client_factory=requests.Session,*,before_send=None):
    from phone_account_social import sign
    body=json.dumps(make_body(request),separators=(',',':')).encode()
    url,headers=sign(request_context(flow.transport.context),body,path=PATH)
    address=urlsplit(url)
    if address.scheme!='https' or address.netloc!=HOST or address.path!=PATH or address.fragment:raise AccountError('删除请求目标无效')
    headers=reading_minimal_headers(headers)
    cookies={c.name:c.value for c in flow.transport.client.cookies}
    headers.update(region_headers(cookies))
    if flow.transport.token:headers['X-TT-Token']=flow.transport.token
    if cookies.get('passport_csrf_token'):headers['X-TT-Passport-Csrf-Token']=cookies['passport_csrf_token']
    client=client_factory()
    try:
        client.trust_env=False;client.auth=None;client.headers.clear();client.cookies.clear()
        for key,value in cookies.items():client.cookies.set(key,value,domain=HOST,path='/')
        if client.get_adapter(url).max_retries.total!=0:raise AccountError('删除请求不允许自动重试')
        prepared=client.prepare_request(requests.Request('POST',url,headers=headers,data=body))
        if prepared.url!=url or prepared.body!=body:raise AccountError('删除请求编码发生变化')
        if before_send is not None:before_send()
        started=time.monotonic()
        with client.send(prepared,timeout=(8,20),allow_redirects=False,stream=True,verify=True) as response:
            if response.status_code!=200:return 'unknown'
            chunks=[];size=0
            for chunk in response.iter_content(32768):
                size+=len(chunk)
                if size>2*1024*1024 or time.monotonic()-started>30:return 'unknown'
                chunks.append(chunk)
            return parse_receipt(json.loads(b''.join(chunks)),request['commentId'])
    finally:client.close()

def handle(flow,request,device_path,*,journal_factory=DeleteJournal,send=wire):
    validate(request)
    # UI authorship is checked against this authenticated account again at submit;
    # the server remains authoritative for ownership of the comment itself.
    own=bool(flow.uid and flow.transport.authenticated_cookies() and flow.uid==request['authorId'])
    if not own:
        if request['action']=='comment_delete_status':return public(request,False)
        raise AccountError('只能删除当前红果账号本人发布的内容')
    params=(flow.transport.context or {}).get('params',{})
    if not params.get('device_id'):raise AccountError('账号设备尚未就绪')
    key=hashlib.sha256(json.dumps([flow.uid,params['device_id'],request['kind'],request['seriesId'],request['commentId']],separators=(',',':')).encode()).hexdigest()
    journal=journal_factory(device_path);rows=journal.read();old=rows.get(key)
    if request['action']=='comment_delete_status':return public(request,True,old)
    if old and (old['state'] in ('accepted','unknown') or old['requestId']==request['requestId']):return public(request,True,old)
    if key not in rows and len(rows)>=256:raise AccountError('评论操作记录已满，未发送删除')
    row={'state':'unknown','requestId':request['requestId']};dispatched=False
    def before_send():
        nonlocal dispatched
        rows[key]=row;journal.write(rows);dispatched=True
    try:
        result=send(flow,request,before_send=before_send)
        if not dispatched:raise AccountError('删除请求未进入发送阶段')
        if result not in STATES:result='unknown'
    except Exception:
        if not dispatched:raise AccountError('删除准备未完成，内容尚未发送，请重新打开评论管理。') from None
        result='unknown'
    if result!='unknown':
        rows[key]={'state':result,'requestId':request['requestId']}
        try:journal.write(rows)
        except Exception:return public(request,True,row)
    return public(request,True,rows[key])
