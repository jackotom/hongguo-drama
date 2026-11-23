"""Explicit comment/review reactions; independent wire-contract implementation."""
import hashlib
import json
import os
import re
import uuid
from pathlib import Path
import requests
from phone_account_flow import AccountError
from phone_account_session import protect
from phone_account_transport import region_headers
from phone_account_social import sign
from phone_account_device import MAX_RESPONSE
from phone_danmaku_like_contract import make_body as danmaku_body

PATH = '/novel/commentapi/comment/do_action/v1/'
UNKNOWN = {'state': 'unknown', 'message': '点赞结果尚未确认，请先在手机红果核对；不会自动重试。'}


def validate(request, mutate=False):
    if request.get('kind') not in ('comments', 'reviews', 'danmaku'):
        raise AccountError('不支持的点赞对象')
    for key, pattern in [('seriesId', r'[1-9][0-9]{7,23}'), ('commentId', r'[1-9][0-9]{4,29}')]:
        if not isinstance(request.get(key), str) or not re.fullmatch(pattern, request[key]):
            raise AccountError('点赞对象无效，请重新打开评论')
    if request['kind'] == 'danmaku':
        if type(request.get('episode')) is not int or not 1 <= request['episode'] <= 100000:
            raise AccountError('弹幕点赞集数无效')
        if mutate:
            try: danmaku_body(request['commentId'], request.get('videoId'), request.get('liked'))
            except ValueError: raise AccountError('弹幕点赞缺少有效的本集资料') from None
        elif 'videoId' in request or 'liked' in request or 'requestId' in request:
            raise AccountError('读取弹幕点赞记录不能包含操作')
    elif 'episode' in request or 'videoId' in request:
        raise AccountError('评论点赞不接收弹幕上下文')
    if mutate and (type(request.get('liked')) is not bool or not isinstance(request.get('requestId'), str)
                   or not re.fullmatch(r'[a-zA-Z0-9-]{16,64}', request['requestId'])):
        raise AccountError('点赞操作无效')


def body_for(request):
    validate(request, True)
    if request['kind'] == 'danmaku':
        return danmaku_body(request['commentId'], request['videoId'], request['liked'])
    review = request['kind'] == 'reviews'
    business = {} if review else {'shark_param': {'enter_from': 'MainFragmentActivity',
                                                 'previous_page': '', 'page_list': 'MainFragmentActivity'}}
    return {'object_id': request['commentId'], 'object_type': 2 if review else 8,
            'action_type': 8 if request['liked'] else 9, 'comment_type': 2 if review else 4,
            'business_param': business}


def parse_receipt(root):
    if not isinstance(root, dict): return dict(UNKNOWN)
    code = root.get('code')
    data = root.get('data')
    if isinstance(data, dict) and data.get('error_code') not in (None, 0, '0'):
        code = data['error_code']
    if type(code) not in (str, int) or not re.fullmatch(r'-?[0-9]{1,6}', str(code)):
        return dict(UNKNOWN)
    if str(code) == '0': return {'state': 'accepted', 'message': '红果已接受此操作；赞数以刷新后的公开列表为准。'}
    return {'state': 'rejected', 'message': '红果未接受此次操作（错误码 ' + str(code) + '），没有更改本地赞数。'}


class LikeJournal:
    """Persist uncertainty before dispatch; never borrow or change login records."""
    def __init__(self, device_path, crypt=protect, *, filename='account-social-likes.dpapi', value_key='liked', label='点赞'):
        if (filename,value_key,label) not in (('account-social-likes.dpapi','liked','点赞'),('account-author-follow.dpapi','following','关注')):
            raise ValueError('Unsupported action journal')
        self.path = Path(device_path).with_name(filename)
        self.value_key,self.label=value_key,label
        self.crypt = crypt

    def read(self):
        try:
            if not self.path.exists(): return {}
            if self.path.is_symlink() or self.path.stat().st_nlink != 1 or self.path.stat().st_size > 512000: raise ValueError()
            root = json.loads(self.crypt(self.path.read_bytes(), decrypt=True))
            if root.get('version') != 1 or not isinstance(root.get('rows'), dict) or len(root['rows']) > 256: raise ValueError()
            for key, row in root['rows'].items():
                if not re.fullmatch(r'[a-f0-9]{64}', key) or not isinstance(row, dict): raise ValueError()
                if row.get('state') not in ('accepted', 'rejected', 'unknown') or type(row.get(self.value_key)) is not bool: raise ValueError()
                if not isinstance(row.get('requestId'), str) or not re.fullmatch(r'[a-zA-Z0-9-]{16,64}', row['requestId']): raise ValueError()
            return root['rows']
        except Exception:
            raise AccountError(f'无法读取{self.label}操作记录，未发送新操作') from None

    def write(self, rows):
        temporary = self.path.with_name(self.path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            if len(rows) > 256 or self.path.is_symlink() or (self.path.exists() and self.path.stat().st_nlink != 1): raise ValueError()
            raw = json.dumps({'version': 1, 'rows': rows}, separators=(',', ':')).encode()
            if len(raw) > 500000: raise ValueError()
            with temporary.open('xb') as file:
                file.write(self.crypt(raw)); file.flush(); os.fsync(file.fileno())
            os.replace(temporary, self.path)
        except Exception:
            raise AccountError(f'无法保存{self.label}操作记录，未自动重试') from None
        finally:
            temporary.unlink(missing_ok=True)


def binding(flow, request):
    if not flow.uid or not flow.transport.authenticated_cookies(): raise AccountError('请先登录红果账号')
    params = (flow.transport.context or {}).get('params', {})
    identity = [str(flow.uid), params.get('device_id'), request['kind'], request['seriesId'], request['commentId']]
    if request['kind'] == 'danmaku': identity.append(request['episode'])
    if not identity[1]: raise AccountError('账号设备尚未就绪')
    return hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()


def status(flow, request, journal):
    validate(request)
    row = journal.read().get(binding(flow, request))
    if not row: return {'state': 'unobserved'}
    # This is the last operation receipt, never a fresh query of phone state.
    return {k: row[k] for k in ('state', 'liked', 'requestId')}


def react(flow, request, journal):
    validate(request, True)
    key = binding(flow, request)
    rows = journal.read(); previous = rows.get(key)
    if previous and (previous['state'] == 'unknown' or previous['requestId'] == request['requestId']):
        return {**previous, 'message': UNKNOWN['message'] if previous['state'] == 'unknown' else '已记录此操作，未重复发送。'}
    if key not in rows and len(rows) >= 256: raise AccountError('点赞操作记录已达上限，本次未发送')
    transport = flow.transport; transport.ready()
    body = json.dumps(body_for(request), ensure_ascii=False, separators=(',', ':')).encode()
    url, headers = sign(transport.context, body, path=PATH)
    if request['kind'] == 'danmaku':
        # The public danmaku route selects minimal signing and does not add the
        # comment/review channel headers. Keep our existing signer and bytes.
        excluded = {'x-gorgon', 'x-argus', 'x-ladon', 'x-ss-stub', 'x-tt-trace-id',
                    'comment-source', 'server-channel'}
        headers = {key: value for key, value in headers.items() if key.lower() not in excluded}
    else:
        headers.update({'comment-source': '1' if request['kind'] == 'reviews' else '4',
                        'server-channel': '34' if request['kind'] == 'reviews' else '18'})
    headers.update(region_headers({c.name: c.value for c in transport.client.cookies}))
    if transport.token: headers['X-TT-Token'] = transport.token
    csrf = next((c.value for c in transport.client.cookies if c.name == 'passport_csrf_token'), None)
    if csrf: headers['X-TT-Passport-Csrf-Token'] = csrf
    prepared = transport.client.prepare_request(requests.Request('POST', url, data=body, headers=headers))
    if prepared.url != url or prepared.body != body: raise AccountError('点赞请求编码校验失败，本次未发送')
    row = {'state': 'unknown', 'liked': request['liked'], 'requestId': request['requestId']}
    rows[key] = row; journal.write(rows)
    result = dict(UNKNOWN)
    try:
        settings = transport.client.merge_environment_settings(url, {}, None, None, None); settings['stream'] = True
        with transport.client.send(prepared, timeout=(8, 20), allow_redirects=False, **settings) as response:
            if response.status_code == 200:
                chunks, size = [], 0
                for chunk in response.iter_content(32768):
                    size += len(chunk)
                    if size > MAX_RESPONSE: break
                    chunks.append(chunk)
                else: result = parse_receipt(json.loads(b''.join(chunks)))
    except (requests.RequestException, ValueError, TypeError): pass
    row['state'] = result['state']
    try: journal.write(rows)
    except AccountError: return {**UNKNOWN, 'liked': request['liked'], 'requestId': request['requestId']}
    return {**row, 'message': result['message']}
