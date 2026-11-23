"""Authenticated, manual list reads. Never likes, reserves, or changes login."""
import json,re,time
from types import FunctionType
from urllib.parse import urlsplit,parse_qs
from phone_account_flow import AccountError
HOST='api5-normal-lq.fqnovel.com'
PATHS={'likes':'/reading/ugc/action/mget/v','reservations':'/reading/user/subscribe/list/v1/'}

def query(kind,offset=0,online=False):
    if kind not in PATHS or type(offset) is not int or not 0<=offset<=2000 or type(online) is not bool or (kind=='likes' and online):raise AccountError('手机片单分页参数无效')
    if kind=='likes':return {'object_type_list':'6,15,10','action_type':'3','offset':str(offset),'count':'100'}
    return {'limit':'20','offset':str(offset),'subscribe_offset':str(offset),'tab_type':'13','subscribe_order_type':'0','swipe_type':'0','need_calendar_schema':'false','is_online':str(online).lower()}

def prepare(context,kind,offset=0,online=False,now_ms=None):
    import phone_account_transport as protocol
    from phone_account_favorites import request_context,reading_minimal_headers
    fields=query(kind,offset,online);path=PATHS[kind];original=protocol.signed_request
    signer=FunctionType(original.__code__,{**original.__globals__,'LIBRARY':set(protocol.LIBRARY)|set(PATHS.values())},original.__name__,original.__defaults__,original.__closure__)
    url,body,headers=signer(request_context(context),path,extra=fields,now_ms=now_ms)
    parts=urlsplit(url)
    if parts.scheme!='https' or parts.netloc!=protocol.HOST or parts.path!=path or parts.fragment or body:raise AccountError('手机片单请求路由异常')
    values=parse_qs(parts.query,keep_blank_values=True)
    if any(values.get(k)!=[v] for k,v in fields.items()):raise AccountError('手机片单请求参数异常')
    return 'https://'+HOST+path+'?'+parts.query,reading_minimal_headers(headers)

def identity(value):
    value=str(value) if type(value) in (str,int) else ''
    return value if re.fullmatch(r'[1-9][0-9]{7,23}',value) else ''

def text(value,limit):return value.strip()[:limit] if isinstance(value,str) else ''

def series(sid,title,cover='',intro='',count=0):
    if not identity(sid) or not text(title,200):raise AccountError('手机片单剧集资料不完整')
    return {'seriesId':sid,'title':text(title,200),'cover':text(cover,8192),'intro':text(intro,4000),
            'episodeCount':count if type(count) is int and 0<=count<=100000 else 0,
            'actors':[],'tags':[],'webAccessibleEpisodes':0,'source':'novelfm'}

def parse_page(root,kind,offset=0,online=False):
    from phone_account_favorites import classify_response
    query(kind,offset,online)
    if classify_response(root)!='acknowledged' or not isinstance(root.get('data'),dict):raise AccountError('手机片单读取未完成，原列表和登录保持原样。')
    data=root['data'];rows=data.get('mixed_data_list' if kind=='likes' else 'subscribe_items');more=data.get('has_more');nxt=data.get('next_offset')
    if not isinstance(rows,list) or len(rows)>200 or type(more) is not bool:raise AccountError('手机片单格式尚未识别')
    if more and (not rows or type(nxt) is not int or not offset<nxt<=2000):raise AccountError('手机片单分页没有前进')
    items={};unsupported=0
    for row in rows:
        if not isinstance(row,dict):raise AccountError('手机片单条目格式异常')
        if kind=='likes':
            video=row.get('video_data')
            if not isinstance(video,dict):unsupported+=1;continue
            detail=video.get('video_detail');detail=detail if isinstance(detail,dict) else {}
            sid=identity(detail.get('series_id_str') or video.get('series_id') or detail.get('series_id'))
            if not sid:unsupported+=1;continue
            value=series(sid,detail.get('series_title') or video.get('title'),detail.get('series_cover') or video.get('cover'),detail.get('series_intro') or video.get('video_desc'),detail.get('episode_cnt',video.get('episode_cnt',0)))
            items[sid]={'series':value,'online':True,'playable':video.get('disable_play') is not True,'note':''}
        else:
            if type(row.get('has_subscribed')) is not bool or type(row.get('is_online')) is not bool:raise AccountError('预约状态未确认，原列表保持原样。')
            if not row['has_subscribed']:unsupported+=1;continue
            if row['is_online']!=online:raise AccountError('预约分区不匹配，请重新读取')
            detail=row.get('subscribe_data');detail=detail if isinstance(detail,dict) else {}
            sid=identity(detail.get('series_id') or row.get('item_id'))
            if not sid:unsupported+=1;continue
            video_detail=detail.get('video_detail');video_detail=video_detail if isinstance(video_detail,dict) else {}
            value=series(sid,video_detail.get('series_title') or detail.get('title') or row.get('name'),video_detail.get('series_cover') or detail.get('cover') or row.get('cover'),video_detail.get('series_intro') or detail.get('video_desc') or row.get('item_desc'),video_detail.get('episode_cnt',detail.get('episode_cnt',0)))
            # Online responses omit the presentation-only show_play_icon field.
            # Open details first; the normal player still resolves playable episodes.
            item={'series':value,'online':online,'playable':online and bool(identity(detail.get('series_id'))) and detail.get('disable_play') is not True,'note':text(row.get('expected_rec_text'),200)}
            item['reservationId']=identity(row.get('item_id'))
            # Collapsed display rows cannot prove an absent membership target.
            if sid in items and items[sid].get('reservationId') != item['reservationId']:
                unsupported+=1
            stamp=row.get('schedule_publish_time') or row.get('expected_publish_time')
            if type(stamp) is int and 946684800<=stamp<=4102444800:item['publishAt']=stamp
            items[sid]=item
    if rows and not items and not unsupported:raise AccountError('手机片单条目尚未识别')
    result={'kind':kind,'items':list(items.values()),'offset':offset,'nextOffset':nxt if more else offset,'hasMore':more,
            'retrievedCount':len(rows),'unsupportedCount':unsupported,'online':online,'syncedAt':int(time.time())}
    for name in ('online_total_count','offline_total_count'):
        if type(data.get(name)) is int and 0<=data[name]<=100000:result['onlineTotal' if name.startswith('online_') else 'offlineTotal']=data[name]
    return result

def fetch(flow,kind,offset=0,online=False):
    import requests
    from phone_account_favorites import authenticated
    from phone_account_transport import region_headers
    query(kind,offset,online);authenticated(flow);transport=flow.transport
    url,headers=prepare(transport.context,kind,offset,online)
    cookies={c.name:c.value for c in transport.client.cookies};headers.update(region_headers(cookies))
    if transport.token:headers['X-TT-Token']=transport.token
    if cookies.get('passport_csrf_token'):headers['X-TT-Passport-Csrf-Token']=cookies['passport_csrf_token']
    with requests.Session() as client:
        client.trust_env=False;client.auth=None;client.headers.clear();client.cookies.clear()
        for k,v in cookies.items():client.cookies.set(k,v,domain=HOST,path='/')
        if client.get_adapter(url).max_retries.total!=0:raise AccountError('手机片单不允许自动重试')
        prepared=client.prepare_request(requests.Request('GET',url,headers=headers))
        if prepared.url!=url or prepared.body is not None:raise AccountError('手机片单编码异常，未发送')
        try:
            started=time.monotonic()
            with client.send(prepared,timeout=(8,20),allow_redirects=False,stream=True) as response:
                if response.status_code!=200:raise AccountError('手机片单服务暂不可用，登录保持原样。')
                chunks=[];size=0
                for chunk in response.iter_content(32768):
                    size+=len(chunk)
                    if size>2*1024*1024 or time.monotonic()-started>30:raise AccountError('手机片单响应超出限制')
                    chunks.append(chunk)
                return parse_page(json.loads(b''.join(chunks)),kind,offset,online)
        except (requests.RequestException,ValueError,TypeError):raise AccountError('手机片单暂未读取成功，原列表和登录保持原样。') from None
