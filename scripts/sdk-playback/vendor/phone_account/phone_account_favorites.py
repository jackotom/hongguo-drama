"""Independent single-item cloud-favorite contract; no network side effects.

The host must bind this to the authenticated account, persist an attempt before
dispatch, and perform one complete shelf read afterward. This module neither
retries writes nor treats a transport acknowledgement as verified cloud state.
"""
import re
import json
import time
import gzip
import secrets
import base64
import struct
from urllib.parse import urlsplit

PATH = '/reading/bookapi/bookshelf/video/update/v'


class FavoriteError(ValueError):
    pass


def make_body(request, now_ms):
    if not isinstance(request, dict):
        raise FavoriteError('收藏操作参数无效')
    sid, wanted = request.get('seriesId'), request.get('favorite')
    if not isinstance(sid, str) or not re.fullmatch(r'[1-9][0-9]{7,23}', sid):
        raise FavoriteError('剧集标识无效，请重新打开剧集')
    if type(wanted) is not bool:
        raise FavoriteError('请选择添加或取消手机收藏')
    attempt = request.get('requestId')
    if not isinstance(attempt, str) or not re.fullmatch(r'[a-zA-Z0-9-]{16,64}', attempt):
        raise FavoriteError('收藏操作标识无效')
    if type(now_ms) is not int or not 946684800000 <= now_ms <= 4102444800000:
        raise FavoriteError('系统时间异常，尚未更改手机收藏')
    # Endpoint source context only; no mobile telemetry or counters are emitted.
    return {'is_cancelled': False, 'update_bookshelf_video_list': [{
        'book_id': sid, 'book_type': 2, 'modify_time': now_ms,
        'video_shelf_operate_type': 0 if wanted else 1,
    }], 'shark_extra': {'enter_from':'MainFragmentActivity','previous_page':'',
        'page_list':'MainFragmentActivity','is_active_behavior':'true','inactive_type':'0'}}


def classify_response(root):
    """A successful POST is only acknowledged, never independently verified."""
    if not isinstance(root, dict):
        return 'unknown'
    data = root.get('data')
    codes = [root.get('code')]
    if 'error_code' in root:
        codes.append(root['error_code'])
    if isinstance(data, dict) and 'error_code' in data:
        codes.append(data['error_code'])
    for code in codes:
        if type(code) not in (int, str) or not re.fullmatch(r'-?[0-9]{1,6}', str(code)):
            return 'unknown'
    if any(str(code) != '0' for code in codes):
        return 'rejected'
    return 'acknowledged'


def verify_membership(root, wanted, observed):
    """observed is bool only after a fresh, complete read for the same account.

    None denotes partial/unavailable data. Absence from a partial first page is
    not proof of removal. Callers must keep an unknown attempt for reconciliation.
    """
    if type(wanted) is not bool:
        raise FavoriteError('收藏目标状态无效')
    state = classify_response(root)
    if state == 'rejected':
        return {'state': 'rejected', 'message': '红果未接受此次收藏操作，桌面收藏保持原样。'}
    # Even a lost response can be resolved by a fresh read of the desired state.
    if type(observed) is bool and observed == wanted:
        return {'state': 'verified', 'favorite': wanted,
                'message': '已确认手机收藏状态。'}
    return {'state': 'unknown', 'message': '手机收藏结果尚未确认，请先重新读取，勿重复提交。'}


def public_receipt(row):
    messages = {'verified':'已确认手机收藏状态。','rejected':'红果未接受此次操作，桌面收藏保持原样。',
                'unknown':'手机收藏结果尚未确认，请先核对，勿重复提交。',
                'acknowledged':'操作已提交，正在等待读取手机收藏核对。'}
    return {key:row[key] for key in ('requestId','seriesId','favorite','state')} | {'message':messages[row['state']]}


def record_response(transport, root):
    """Last numeric outcome only, never provider text, IDs, body or credentials."""
    diagnostics = getattr(transport, 'diagnostics', None)
    if diagnostics is None or not isinstance(root, dict): return
    def code(value):
        return str(value) if type(value) in (int,str) and re.fullmatch(r'-?[0-9]{1,6}',str(value)) else None
    data=root.get('data') if isinstance(root.get('data'),dict) else {}
    result={'at':int(time.time()),'rootCode':code(root.get('code')),
            'rootErrorCode':code(root.get('error_code')),'dataErrorCode':code(data.get('error_code')),
            'state':classify_response(root)}
    try:
        path=diagnostics.path.with_name('account-favorite-status.json')
        temporary=path.with_suffix('.tmp')
        temporary.write_text(json.dumps(result,separators=(',',':')),encoding='utf8')
        temporary.replace(path)
    except OSError: pass


def authenticated(flow):
    if not flow.uid or not flow.transport.authenticated_cookies():
        raise FavoriteError('请先登录红果账号')
    flow.transport.ready()
    from phone_favorite_journal import account_binding
    return account_binding(flow)


def request_context(context):
    """Use application parameters while retaining this device's identity.

    Registration-only fields are not part of the bookshelf request contract.
    Reuse our established account defaults without mutating the saved device.
    """
    from phone_account_transport import ACCOUNT_FIELDS, ACCOUNT_DEFAULTS
    params = {key: str(value) for key, value in context['params'].items() if key in ACCOUNT_FIELDS}
    for key, value in ACCOUNT_DEFAULTS.items():
        params.setdefault(key, value)
    if 'version_code' in params:
        params.setdefault('pv_player', params['version_code'])
    return {**context, 'params': params}


def prepare_reading_json(context, body, now_ms=None, path=PATH):
    """Favorite-only wire contract verified by complete add/remove readback.

    Reuse our signer and inner proof; other account endpoints are unchanged.
    """
    if path not in (PATH, '/reading/bookapi/read_history/update/v', '/reading/bookapi/read_progress/upload/v'):
        raise FavoriteError('不支持的阅读记录接口')
    from phone_account_social import sign
    from phone_account_transport import ORIGIN,FAVORITES_HOST
    url,headers=sign(context,body,now_ms=now_ms,path=path)
    parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.netloc!=urlsplit(ORIGIN).netloc or parsed.path!=path or not parsed.query or parsed.fragment:
        raise FavoriteError('收藏签名路由异常，尚未发送')
    headers=reading_minimal_headers(headers)
    return 'https://'+FAVORITES_HOST+path+'?'+parsed.query,headers


def reading_minimal_headers(headers):
    headers={k:v for k,v in headers.items() if k.lower() not in ('x-gorgon','x-argus','x-ladon','x-ss-stub','x-tt-trace-id')}
    names={k.lower():k for k in headers}
    if len(names)!=len(headers):raise FavoriteError('收藏签名头重复，尚未发送')
    seconds=int(headers[names['x-khronos']]);raw=base64.b64decode(headers[names['x-medusa']],validate=True)
    if not 0<=seconds<=0xffffffff:raise FavoriteError('收藏签名时间异常，尚未发送')
    mask=struct.pack('<I',seconds)*5
    if len(raw)<272 or bytes(a^b for a,b in zip(raw[:20],mask))!=bytes.fromhex('050000002d4b4fca49750d433fb5ae2c226dcc56'):
        raise FavoriteError('收藏签名版本异常，尚未发送')
    frame=bytes.fromhex('03000000f7e85ffad7d7dc3bd62ac87057cf6118')
    headers[names['x-medusa']]=base64.b64encode(bytes(a^b for a,b in zip(frame,mask))+raw[20:]).decode()
    return headers


def prepare_favorite(context, body, now_ms=None):
    return prepare_reading_json(context, body, now_ms=now_ms, path=PATH)


def mutate(flow, request, journal, client_factory=None):
    """One explicit write at most. Duplicate/uncertain entries only return state."""
    import requests
    from phone_account_transport import region_headers,FAVORITES_HOST
    from phone_account_device import MAX_RESPONSE
    now_ms = int(time.time()*1000)
    payload = json.dumps(make_body(request,now_ms),separators=(',',':')).encode()
    # This JSON route expects gzip on the wire. Sign the final encoded bytes,
    # not the uncompressed document; requests must send those same bytes.
    body = gzip.compress(payload, compresslevel=6, mtime=0)
    account = authenticated(flow)
    transport = flow.transport
    # Prepare before reserving, so local encoding/signature errors cannot create
    # an apparently dispatched attempt. Reservation still precedes client.send.
    url,headers = prepare_favorite(request_context(transport.context),body)
    headers['Content-Encoding'] = 'gzip'
    headers['X-Reading-Request'] = f'{now_ms}-{100000000 + secrets.randbelow(900000000)}'
    cookies={c.name:c.value for c in transport.client.cookies}
    headers.update(region_headers(cookies))
    if transport.token: headers['X-TT-Token']=transport.token
    csrf=next((c.value for c in transport.client.cookies if c.name=='passport_csrf_token'),None)
    if csrf:headers['X-TT-Passport-Csrf-Token']=csrf
    client=(client_factory or requests.Session)()
    try:
        client.trust_env=False;client.auth=None;client.cookies.clear()
        for name,value in cookies.items():client.cookies.set(name,value,domain=FAVORITES_HOST,path='/')
        if client.get_adapter(url).max_retries.total!=0:raise FavoriteError('收藏发送不允许自动重试')
        prepared=client.prepare_request(requests.Request('POST',url,data=body,headers=headers))
        if prepared.url!=url or prepared.body!=body:raise FavoriteError('收藏请求编码异常，尚未发送')
        row,send=journal.begin(account,request)
        if not send:return public_receipt(row)
        result='unknown'
        try:
            started=time.monotonic()
            with client.send(prepared,timeout=(8,20),allow_redirects=False,stream=True) as response:
                if response.status_code==200:
                    chunks,size=[],0
                    for chunk in response.iter_content(32768):
                        size+=len(chunk)
                        if size>MAX_RESPONSE or time.monotonic()-started>45:return public_receipt(row)
                        chunks.append(chunk)
                    root=json.loads(b''.join(chunks))
                    record_response(transport,root)
                    result=classify_response(root)
        except (requests.RequestException,ValueError,TypeError):
            return public_receipt(row)
        try:return public_receipt(journal.finish(account,row['requestId'],result))
        except FavoriteError:return public_receipt(row) # Durable unknown remains.
    finally:client.close()


def reconcile(flow, request_id, observed, journal):
    """Only the host's fresh shelf read may supply observed; never UI input."""
    account=authenticated(flow)
    if type(observed) is not bool and observed is not None:raise FavoriteError('收藏核对状态无效')
    row=journal.find(account,request_id)
    if row is None:raise FavoriteError('没有找到此账号的收藏操作记录')
    if row['state'] in ('verified','rejected'):return public_receipt(row)
    # A lost POST response can still be resolved by reading the actual state.
    # This verifies current membership, not which client caused the change.
    if verify_membership(None,row['favorite'],observed)['state']=='verified':
        row=journal.finish(account,request_id,'verified')
    return public_receipt(row)


def pending(flow,journal):
    return [public_receipt(row) for row in journal.pending(authenticated(flow))]
