"""Authorized manual reservation adapter; no automatic mutation or retries."""
import json,time,secrets
from phone_reservation import ReservationError,ReservationJournal,prepare,validate,change,reconcile,public
from phone_account_favorites import authenticated,FavoriteError

# Not request-controlled. Manual single-item changes authorized by the user;
# network success and phone-side effects still require explicit readback.
WRITES_ENABLED=True

def status(flow,journal):
    account=authenticated(flow)
    return {'writesEnabled':WRITES_ENABLED,'pending':[public(row) for row in journal.pending(account)]}

def confirm(flow,request_id,journal):
    from phone_optional_lists import fetch
    from phone_reservation import validate as validate_request
    validate_request({'itemId':'12345678','reserved':False,'requestId':request_id})
    account=authenticated(flow)
    return reconcile(account,request_id,journal,lambda online,offset:fetch(flow,'reservations',offset,online))

def mutate(flow,request,journal,client_factory=None):
    if WRITES_ENABLED is not True:raise ReservationError('手机预约功能尚未开放，原预约保持不变。')
    import requests
    from phone_account_transport import region_headers
    from phone_reservation import HOST
    validate(request);account=authenticated(flow);transport=flow.transport
    now_ms=int(time.time()*1000)
    url,headers,body=prepare(transport.context,request,now_ms)
    cookies={c.name:c.value for c in transport.client.cookies}
    headers.update(region_headers(cookies))
    headers['X-Reading-Request']=f'{now_ms}-{100000000+secrets.randbelow(900000000)}'
    if transport.token:headers['X-TT-Token']=transport.token
    if cookies.get('passport_csrf_token'):headers['X-TT-Passport-Csrf-Token']=cookies['passport_csrf_token']
    client=(client_factory or requests.Session)()
    try:
        client.trust_env=False;client.auth=None;client.headers.clear();client.cookies.clear()
        for name,value in cookies.items():client.cookies.set(name,value,domain=HOST,path='/')
        if client.get_adapter(url).max_retries.total!=0:raise ReservationError('预约提交不允许自动重试')
        prepared=client.prepare_request(requests.Request('POST',url,data=body,headers=headers))
        if prepared.url!=url or prepared.body!=body:raise ReservationError('预约编码异常，尚未提交')
        def send(_payload):
            started=time.monotonic()
            with client.send(prepared,timeout=(8,20),allow_redirects=False,stream=True) as response:
                if response.status_code!=200:return None
                chunks=[];size=0
                for chunk in response.iter_content(32768):
                    size+=len(chunk)
                    if size>2*1024*1024 or time.monotonic()-started>30:return None
                    chunks.append(chunk)
                return json.loads(b''.join(chunks))
        def deferred_read(_online,_offset):
            # A separate serialized confirmation keeps the POST pipe deadline bounded.
            raise ReservationError('请读取确认预约状态')
        return change(account,request,journal,send,deferred_read,enabled=True)
    finally:client.close()

def handle(flow,request,device_path):
    action=request.get('action')
    allowed={'reservation_status':{'action'},'reservation_confirm':{'action','requestId'},
             'reservation':{'action','itemId','reserved','requestId'}}
    if action not in allowed or set(request)!=allowed[action]:raise ReservationError('预约操作参数无效')
    journal=ReservationJournal(device_path)
    if action=='reservation_status':return status(flow,journal)
    if action=='reservation_confirm':return confirm(flow,request['requestId'],journal)
    return mutate(flow,{key:value for key,value in request.items() if key!='action'},journal)
