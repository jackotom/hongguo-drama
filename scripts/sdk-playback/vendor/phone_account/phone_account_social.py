"""User-triggered publishing over the existing private account session.

Only the public request contract is implemented here. No guest client, auto
retry, remote test posts, body logging, or credential export.
"""
import hashlib
import json
import re
import time
from urllib.parse import urlencode
import requests
from phone_account_flow import AccountError
from phone_account_transport import ORIGIN, region_headers
from phone_account_device import MAX_RESPONSE
from phone_account_signing import passport_components
from phone_account_medusa import medusa
from phone_account_medusa_digest import selector

PATH = '/novel/commentapi/comment/add/v1/'
REPLY_PATH = '/novel/commentapi/reply/add/v1/'
UNKNOWN = {'state': 'unknown', 'message': '发送结果尚未确认，请先在手机红果检查，勿重复发送。', 'commentId': ''}


def validate(request):
    kind = request.get('kind')
    if kind not in ('comments', 'danmaku', 'danmaku-replies', 'replies', 'reviews', 'review-replies'): raise AccountError('不支持的发送类型')
    picture_ids = request.get('pictureIds', [])
    image_context = request.get('pictureContextId')
    if (not isinstance(picture_ids, list) or len(picture_ids)>9
        or any(not isinstance(x,str) or not re.fullmatch(r'[a-f0-9]{32}',x) for x in picture_ids)
        or len(set(picture_ids))!=len(picture_ids)):
        raise AccountError('图片引用无效，内容尚未发送')
    if picture_ids:
        if kind!='comments' or not isinstance(image_context,str) or not re.fullmatch(r'[a-f0-9]{64}',image_context):
            raise AccountError('图片与评论类型或账号不一致，内容尚未发送')
    elif image_context is not None: raise AccountError('图片账号信息缺少图片，内容尚未发送')
    target = request.get('replyTarget')
    if kind in ('replies','review-replies','danmaku-replies'):
        if not isinstance(target, dict) or set(target) - {'commentId', 'replyId', 'userId'}: raise AccountError('回复对象无效，内容尚未发送')
        for key in ('commentId', 'replyId', 'userId'):
            value = target.get(key, '')
            if not isinstance(value, str) or ((key == 'commentId' or value) and (not re.fullmatch(r'[0-9]{5,30}', value) or not value.strip('0'))):
                raise AccountError('回复对象无效，内容尚未发送')
        if kind == 'danmaku-replies' and target.get('replyId'): raise AccountError('弹幕回复对象无效，内容尚未发送')
    elif target is not None: raise AccountError('发送类型与回复对象不一致，内容尚未发送')
    for key in ('seriesId', 'videoId'):
        if not isinstance(request.get(key), str) or not re.fullmatch(r'[0-9]{8,24}', request[key]):
            raise AccountError('剧集信息无效，请重新打开播放器')
    text = request.get('text')
    if not isinstance(text, str) or (not text.strip() and not picture_ids) or len(text) > (50 if kind in ('danmaku','danmaku-replies') else 500):
        raise AccountError('请输入有效内容；评论最多500字，弹幕最多50字')
    if any((ord(c) < 32 and c != '\n') or 127 <= ord(c) < 160 for c in text):
        raise AccountError('内容包含不支持的控制字符')
    offset = request.get('offsetMs')
    duration = request.get('durationMs')
    if type(offset) is not int or type(duration) is not int or not 0 <= offset < 86400000:
        raise AccountError('弹幕播放位置无效')
    if kind in ('danmaku','danmaku-replies') and (duration <= 0 or offset >= duration): raise AccountError('弹幕播放位置超出本集范围')
    if kind in ('reviews','review-replies') and offset!=0:raise AccountError('剧评不绑定播放时间，内容尚未发送')
    if not re.fullmatch(r'[a-zA-Z0-9-]{16,64}', str(request.get('requestId', ''))): raise AccountError('发送标识无效')
    return text.strip()


def make_body(request, text, pictures=None):
    dm = request['kind'] == 'danmaku'
    if request['kind'] in ('reviews','review-replies'):
        reply=request['kind']=='review-replies'
        business={'book_id':request['seriesId'],'ignore_urge_rule':False,'has_aigc_content':False,
                  'is_confirm_request':False,'offset':0,'read_item_cnt':0,
                  'support_para_audio_play':False,'text_feature':{},'video_is_muted':0,'from_famous_comment_id':0}
        body={'aid':8662,'group_id':request['seriesId'],'group_type':1,'data_type':2,
              'commit_source':13 if reply else 12,'text':text,'business_param':business}
        if reply:
            target=request['replyTarget'];body['reply_to_comment_id']=target['commentId'];business['log_extra']={}
            if target.get('replyId'):body['reply_to_reply_id']=target['replyId']
        else:
            body.update(comment_type=0,image_data=[],rich_text=[])
            business.update(aigc_template_id=0,aigc_template_text='',comment_tag_list=[])
        return body
    if request['kind'] in ('replies','danmaku-replies'):
        dm_reply = request['kind'] == 'danmaku-replies'
        target = request['replyTarget']
        body = {'aid': 8662, 'group_id': request['videoId'], 'group_type': 30,
                'data_type': 20 if dm_reply else 4, 'commit_source': 1501 if dm_reply else 9, 'text': text, 'reply_to_comment_id': target['commentId'],
                'business_param': {'book_id': request['seriesId'], 'ignore_urge_rule': False,
                                   'text_feature': {}, 'has_aigc_content': False, 'offset': request['offsetMs'] if dm_reply else 0, 'log_extra': {}}}
        if dm_reply:
            body['business_param']['shark_param'] = {'enter_from': 'MainFragmentActivity', 'previous_page': '', 'page_list': 'MainFragmentActivity'}
        if target.get('replyId'): body['reply_to_reply_id'] = target['replyId']
        if target.get('userId'): body['reply_to_userid'] = target['userId']
        return body
    business = {'book_id': request['seriesId'], 'ignore_urge_rule': False,
                'offset': request['offsetMs'] if dm else 0}
    if not dm: business.update(text_feature={}, has_aigc_content=False, preset_text_id='', log_extra={})
    body = {'aid': 8662, 'group_id': request['videoId'], 'group_type': 30,
            'data_type': 20 if dm else 4, 'commit_source': 1500 if dm else 3,
            'text': text, 'business_param': business}
    if pictures: body['image_data'] = pictures
    return body


def sign(context, body, now_ms=None, path=PATH):
    if path not in (PATH, REPLY_PATH, '/novel/commentapi/comment/del/v1/', '/novel/commentapi/comment/do_action/v1/', '/novel/articleapi/do_action/v1/', '/reading/bookapi/bookshelf/video/update/v', '/reading/bookapi/read_progress/get/v', '/reading/bookapi/read_history/update/v', '/reading/bookapi/read_progress/upload/v', '/reading/bookapi/search/uncover_subscribe/v'):
        raise AccountError('不支持的 JSON 接口')
    params = {str(k): str(v) for k, v in context['params'].items() if k != 'tt_data'}
    ms = int(time.time()*1000) if now_ms is None else now_ms
    seconds = ms // 1000
    params['ts'] = str(seconds)
    for nonce in range(256):
        params['_rticket'] = str(ms + nonce)
        query = urlencode(sorted(params.items())).encode()
        if (selector(hashlib.new('sm3', query).digest(), hashlib.md5(body).digest(), seconds) & 15) % 3 == 2: break
    else: raise AccountError('发送签名准备失败，内容尚未发送')
    headers = passport_components(query, body, seconds)
    headers.update({'X-Medusa': medusa(query, body, seconds, params['device_id']),
                    'User-Agent': context['user_agent'], 'Accept': 'application/json',
                    'Content-Type': 'application/json; charset=utf-8', 'X-SS-DP': '8662',
                    'X-SS-REQ-TICKET': params['_rticket'], 'comment-source': '4', 'server-channel': '18'})
    if path not in (PATH, REPLY_PATH):
        headers.pop('comment-source');headers.pop('server-channel')
    return ORIGIN + path + '?' + query.decode(), headers


def receipt(root, kind='comments'):
    if not isinstance(root, dict): return dict(UNKNOWN)
    data = root.get('data')
    code = root.get('code')
    nested = data.get('error_code') if isinstance(data, dict) else None
    if nested not in (None, 0, '0'): code = nested
    if type(code) in (str, int) and re.fullmatch(r'-?[0-9]{1,6}', str(code)) and str(code) != '0':
        return {'state': 'rejected', 'message': '红果未接受此次发送（错误码 ' + str(code) + '）。草稿已保留。', 'commentId': ''}
    if str(code) != '0' or not isinstance(data, dict): return dict(UNKNOWN)
    is_reply=kind in ('replies','review-replies','danmaku-replies')
    name = 'reply' if is_reply else 'comment'
    comment = data.get(name) if isinstance(data.get(name), dict) else data
    cid = str(comment.get('reply_id' if is_reply else 'comment_id') or '')
    if not re.fullmatch(r'[0-9]{5,30}', cid): return dict(UNKNOWN)
    return {'state': 'accepted', 'message': '已提交给红果，公开展示可能稍有延迟。', 'commentId': cid}


def publish(flow, request, attempts, *, pictures=None):
    text = validate(request)
    if request.get('pictureIds'):
        from phone_picture_journal import valid_image
        if (not isinstance(pictures,list) or len(pictures)!=len(request['pictureIds'])
            or any(not valid_image(image) for image in pictures)):
            raise AccountError('图片未通过本机上传回执核对，内容尚未发送')
    elif pictures: raise AccountError('图片缺少上传引用，内容尚未发送')
    if not flow.uid or not flow.transport.authenticated_cookies(): raise AccountError('请先登录红果账号')
    transport = flow.transport
    transport.ready()
    body = json.dumps(make_body(request, text, pictures), ensure_ascii=False, separators=(',', ':')).encode()
    fingerprint = hashlib.sha256(str(flow.uid).encode() + b'\0' + body).hexdigest()
    request_id = request['requestId']
    # Do not replay an uncertain/accepted request after double clicks, remounts,
    # a changed request id, or returning to the same episode in this session.
    for entry in attempts.values():
        if entry['fingerprint'] == fingerprint and entry['receipt']['state'] != 'rejected': return dict(entry['receipt'])
    if request_id in attempts:
        raise AccountError('该发送标识已使用，请重新编辑内容')
    if len(attempts) >= 200: raise AccountError('本次会话发送次数已达上限')
    url, headers = sign(transport.context, body, path=REPLY_PATH if request['kind'] in ('replies','review-replies','danmaku-replies') else PATH)
    if request['kind'] == 'danmaku-replies':
        excluded = {'x-gorgon', 'x-argus', 'x-ladon', 'x-ss-stub', 'x-tt-trace-id', 'comment-source', 'server-channel'}
        headers = {key: value for key, value in headers.items() if key.lower() not in excluded}
    if request['kind'] in ('reviews','review-replies'):
        headers.update({'comment-source':'1','server-channel':'34'})
    headers.update(region_headers({c.name: c.value for c in transport.client.cookies}))
    if transport.token: headers['X-TT-Token'] = transport.token
    csrf = next((c.value for c in transport.client.cookies if c.name == 'passport_csrf_token'), None)
    if csrf: headers['X-TT-Passport-Csrf-Token'] = csrf
    prepared = transport.client.prepare_request(requests.Request('POST', url, data=body, headers=headers))
    if prepared.url != url or prepared.body != body: raise AccountError('发送编码校验失败，内容尚未发送')
    attempts[request_id] = {'fingerprint': fingerprint, 'receipt': dict(UNKNOWN)}
    try:
        settings = transport.client.merge_environment_settings(url, {}, None, None, None)
        settings['stream'] = True
        with transport.client.send(prepared, timeout=(8, 20), allow_redirects=False, **settings) as response:
            if response.status_code != 200: return dict(UNKNOWN)
            chunks, size = [], 0
            for chunk in response.iter_content(32768):
                size += len(chunk)
                if size > MAX_RESPONSE: return dict(UNKNOWN)
                chunks.append(chunk)
            result = receipt(json.loads(b''.join(chunks)), request['kind'])
            attempts[request_id]['receipt'] = result
            return dict(result)
    except (requests.RequestException, ValueError, TypeError):
        return dict(UNKNOWN)
