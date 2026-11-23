"""Single-series, explicit progress handoff. Never mutates login or local history."""
import gzip
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit
from phone_account_flow import AccountError

HISTORY = '/reading/bookapi/read_history/list/v'
UPDATE = '/reading/bookapi/read_history/update/v'
UPLOAD = '/reading/bookapi/read_progress/upload/v'


def integer(value, low=0, high=4102444800000):
    if isinstance(value, str) and re.fullmatch(r'[0-9]+', value): value = int(value)
    if type(value) is not int or not low <= value <= high:
        raise AccountError('手机进度字段不完整，未上传；本地记录已保留。')
    return value


def validate(request, now_ms):
    for key in ('seriesId', 'videoId'):
        value = request.get(key)
        if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{7,18}', value) or int(value) > 9223372036854775807:
            raise AccountError('进度与当前剧集不匹配')
    integer(request.get('episode'), 1, 99999)
    integer(request.get('positionMs'), 1, 86400000)
    integer(request.get('watchedAtMs'), now_ms-86400000, now_ms+5000)


def point(row):
    progress = row.get('read_progress', row.get('progress', row))
    timestamps = [integer(progress[k], 946684800000) for k in ('read_timestamp_ms', 'update_timestamp_ms') if k in progress]
    if not timestamps: raise AccountError('手机记录缺少更新时间，未上传。')
    vid = str(progress.get('vid', progress.get('item_id', '')))
    if not re.fullmatch(r'[1-9][0-9]{7,18}', vid): raise AccountError('手机记录缺少视频标识，未上传。')
    position = progress.get('current_play_position', progress.get('current_play_time'))
    return {'videoId':vid, 'index':integer(progress.get('vid_index'),0,99999),
            'positionMs':integer(position,0,86400000), 'updatedAtMs':max(timestamps)}


def decision(local, remote, baseline=None, compare=False):
    if compare and remote != baseline: return '手机进度已更新，已跳过上传。'
    if remote is None: return None
    if remote['updatedAtMs'] >= local['watchedAtMs']: return '手机记录更新，已跳过上传。'
    # Compare positions only when both sides agree on the episode mapping.
    # A different video is expected when advancing episodes, but either half
    # of the identity agreeing on its own is ambiguous and must not be written.
    same_episode = remote['index'] == local['episode']-1
    same_video = remote['videoId'] == local['videoId']
    if same_episode != same_video:
        return '手机与桌面的分集对应不一致，已跳过上传；本地记录已保留。'
    # Do not regress a later episode even when its timestamp is older.
    if remote['index'] > local['episode']-1: return '手机已看到后面的集数，已跳过上传。'
    if remote['videoId'] == local['videoId'] and remote['positionMs'] >= local['positionMs']:
        return '手机续播位置已相同或更靠后，无需上传。'
    return None


def bodies(local):
    # Use the actual watch timestamp, not upload time: delayed work must not
    # masquerade as newer viewing. UI episodes are one-based, wire indices zero-based.
    sid, vid, ix, pos, stamp = local['seriesId'], local['videoId'], local['episode']-1, local['positionMs'], local['watchedAtMs']
    history = dict(book_id=int(sid),book_type=2,vid=int(vid),vid_index=ix,
        current_play_position=pos,player_accumulate_total_time=pos,
        read_timestamp_ms=stamp,update_timestamp_ms=stamp)
    for k in ('is_delete','is_interactive_game','is_listen_mode','user_digg','use_soft_delete','meet_guide_comment_tag','user_playlet_comment_flag'): history[k]=False
    for k in ('chapter_index','is_multi_season','season_index','digged_count','duration','episode_cnt','origin_novel_book_id','recent_reads','retain_video_play_time','series_play_cnt','tone_id'): history[k]=0
    progress = dict(book_id=sid,book_type=2,item_id=vid,vid_index=ix,
        current_play_time=pos,player_cumulative_total_duration=pos,read_timestamp_ms=stamp)
    for k in ('progress_type','channel_id','cur_channel_id','page_index','paragraph_offset','tone_id'): progress[k]=0
    for k in ('check_timestamp','is_listen_mode','is_local_book','listen_and_read'): progress[k]=False
    progress['page_progress_rate']=0.0
    return {UPDATE:{'update_datas':[history]},UPLOAD:{'books':[progress]}}


def wire(flow, path, payload=None, query=None):
    """Isolated cookie jar, exact encoded bytes, no redirects/retries/session adoption."""
    import requests
    from phone_account_favorites import prepare_reading_json, request_context, classify_response
    from phone_account_transport import signed_request, region_headers, HOST, FAVORITES_HOST
    from phone_account_device import MAX_RESPONSE
    transport=flow.transport
    if path==HISTORY and payload is None:
        url,body,headers=signed_request(transport.context,path,extra=query,session=transport.environment)
        host=HOST;body=None;method='GET'
    elif path in (UPDATE,UPLOAD) and isinstance(payload,dict):
        body=gzip.compress(json.dumps(payload,separators=(',',':')).encode(),compresslevel=6,mtime=0)
        url,headers=prepare_reading_json(request_context(transport.context),body,path=path)
        headers['Content-Encoding']='gzip'
        headers['X-Reading-Request']=f'{int(time.time()*1000)}-{secrets.randbelow(900000000)+100000000}'
        host=FAVORITES_HOST;method='POST'
    else: raise AccountError('不支持的进度操作')
    cookies={c.name:c.value for c in transport.client.cookies}
    headers.update(region_headers(cookies))
    if transport.token:headers['X-TT-Token']=transport.token
    if cookies.get('passport_csrf_token'):headers['X-TT-Passport-Csrf-Token']=cookies['passport_csrf_token']
    with requests.Session() as client:
        client.trust_env=False
        for k,v in cookies.items():client.cookies.set(k,v,domain=host,path='/')
        if client.get_adapter(url).max_retries.total!=0:raise AccountError('进度请求禁止自动重试')
        prepared=client.prepare_request(requests.Request(method,url,data=body,headers=headers))
        if prepared.url!=url or prepared.body!=body:raise AccountError('进度请求编码发生变化，未发送')
        try:
            started=time.monotonic()
            with client.send(prepared,timeout=(8,15),allow_redirects=False,stream=True) as response:
                if response.status_code!=200:raise AccountError('手机进度服务暂不可用，登录和本地记录已保留。')
                chunks=[];size=0
                for chunk in response.iter_content(32768):
                    size+=len(chunk)
                    if size>MAX_RESPONSE or time.monotonic()-started>25:raise AccountError('手机进度响应超出限制')
                    chunks.append(chunk)
                root=json.loads(b''.join(chunks))
                if classify_response(root)!='acknowledged':raise AccountError('红果未确认此次进度操作，登录和本地记录已保留。')
                return root
        except (requests.RequestException,ValueError,TypeError):raise AccountError('手机进度响应未确认，请勿重复上传。') from None


def read_remote(flow, sid, call=wire):
    offset=0;seen=set();started=time.monotonic()
    for page in range(10):
        if time.monotonic()-started>75:raise AccountError('手机历史读取超时，未上传。')
        root=call(flow,HISTORY,query={'limit':'20','offset':str(offset),'book_type':'2','full_field':'false',
            'query_soft_deleted':'false','last_min_read_timestamp_ms':'0','is_first_load':str(page==0).lower()})
        data=root.get('data',{});rows=data.get('data_list',data.get('history_list'))
        if not isinstance(rows,list) or len(rows)>500:raise AccountError('手机历史格式未确认，未上传。')
        found=[]
        for row in rows:
            if not isinstance(row,dict):raise AccountError('手机历史格式异常')
            book=row.get('book_info',row.get('book_data',row));rid=str(book.get('book_id_str',book.get('book_id',book.get('series_id',''))))
            if rid in seen:raise AccountError('手机历史分页重复，未上传。')
            seen.add(rid)
            if rid==sid:
                if row.get('is_delete') in (True,1):raise AccountError('手机已删除此历史，未上传。')
                found.append(point(row))
        if found:return found[0]
        more=data.get('has_more')
        if more in (False,0):return None
        if more not in (True,1):raise AccountError('无法确认手机历史完整性，未上传。')
        next_offset=integer(data.get('next_offset'),offset+1)
        if not rows:raise AccountError('手机历史分页为空，未上传。')
        offset=next_offset
    raise AccountError('手机历史尚未读取完整，未上传。')


class ProgressSync:
    def __init__(self, device_path, read=read_remote, send=wire, crypt=None):
        from phone_account_session import protect
        self.path=Path(device_path).with_name('account-progress-sync.dpapi')
        self.read,self.send,self.crypt=read,send,crypt or protect
        self.plans={}
        # Explicit opt-in belongs to this account, series and process only.
        # Never restore automatic writes from disk after a restart.
        self.consents={}

    def consent(self, token, account, sid, now):
        value=self.consents.get(token) if isinstance(token,str) else None
        if not value or value['account']!=account or value['seriesId']!=sid or not 0<=now-value['created']<=21600000:
            raise AccountError('本次自动同步已关闭或过期，请重新开启。')
        return value

    def journal(self):
        try:
            if not self.path.exists():return {}
            if self.path.is_symlink() or self.path.stat().st_size>1048576:raise ValueError()
            value=json.loads(self.crypt(self.path.read_bytes(),decrypt=True))
            if not isinstance(value,dict) or len(value)>512:raise ValueError()
            return value
        except Exception:raise AccountError('进度同步记录暂不可读，未上传。') from None

    def save(self, rows):
        raw=json.dumps(rows,separators=(',',':')).encode()
        if len(raw)>1000000 or len(rows)>512:raise AccountError('进度同步记录已满，未上传。')
        temporary=self.path.with_suffix('.tmp')
        if self.path.is_symlink() or temporary.is_symlink():raise AccountError('进度记录路径异常')
        with temporary.open('wb') as file:
            file.write(self.crypt(raw));file.flush();os.fsync(file.fileno())
        os.replace(temporary,self.path)

    def handle(self, flow, request):
        from phone_account_favorites import authenticated
        account=authenticated(flow);now=int(time.time()*1000)
        action=request.get('action')
        if action=='progress_enable':
            sid=request.get('seriesId')
            if not isinstance(sid,str) or not re.fullmatch(r'[1-9][0-9]{7,18}',sid) or int(sid)>9223372036854775807:
                raise AccountError('当前剧集不支持进度同步')
            # A new opt-in replaces older sessions; no dormant writes remain.
            token=secrets.token_hex(24)
            self.consents={token:{'account':account,'seriesId':sid,'created':now,'lastAttempt':None}}
            return {'state':'enabled','consentToken':token}
        if action=='progress_disable':
            token=request.get('consentToken')
            if isinstance(token,str):self.consents.pop(token,None)
            return {'state':'disabled'}
        if action=='progress_auto_preview':
            grant=self.consent(request.get('consentToken'),account,request.get('seriesId'),now)
            validate(request,now)
            if grant['lastAttempt'] is not None and now-grant['lastAttempt']<60000:
                return {'state':'cooldown','message':'刚刚已检查，将在下次观看后同步。'}
            grant['lastAttempt']=now
            result=self.handle(flow,{**request,'action':'progress_preview'})
            if result.get('state')=='ready':
                self.plans[result['token']]['consentToken']=request['consentToken']
            return result
        if action=='progress_preview':
            validate(request,now)
            local={k:request[k] for k in ('seriesId','videoId','episode','positionMs','watchedAtMs')}
            remote=self.read(flow,local['seriesId'])
            key=account+':'+local['seriesId'];previous=self.journal().get(key)
            if previous and previous.get('state')=='unknown':
                if matches(previous['local'],remote):
                    rows=self.journal()
                    complete=previous.get('stage')=='progress_ack'
                    rows[key]['state']='readback' if complete else 'history_only'
                    self.save(rows)
                    return {'state':rows[key]['state'],'local':previous['local'],'remote':remote,
                        'message':'云端历史已读回一致，请在手机确认续播。' if complete else '已核对上次历史记录；续播接口尚未确认。继续播放几秒后可同步新的位置。'}
                if remote and remote['updatedAtMs']>previous['local']['watchedAtMs']:
                    # A newer phone observation does not acknowledge the lost
                    # request. Retire that old position without replaying it,
                    # then let later viewing go through a fresh preview.
                    rows=self.journal()
                    if rows.get(key)!=previous:raise AccountError('同步记录已变化，请重新核对。')
                    rows[key]={**previous,'state':'superseded','remote':remote,'observedAt':now}
                    self.save(rows)
                    return {'state':'skipped','local':local,'remote':remote,
                        'message':'手机已有更新的观看进度，旧同步已停止补发。本地记录已保留；继续观看后可同步新的位置。'}
                return {'state':'unknown','message':'上次上传结果尚未确认，未重复上传；请稍后读取核对。'}
            if previous and previous.get('state')=='superseded':
                observed=previous.get('remote')
                if (not isinstance(observed,dict) or not remote
                        or type(observed.get('updatedAtMs')) is not int
                        or remote['updatedAtMs']<observed['updatedAtMs']
                        or (remote['updatedAtMs']==observed['updatedAtMs'] and remote!=observed)):
                    return {'state':'skipped','local':local,'remote':remote,
                        'message':'手机进度读取尚未稳定，已跳过上传；本地记录已保留。'}
                if remote['updatedAtMs']>observed['updatedAtMs']:
                    rows=self.journal()
                    if rows.get(key)!=previous:raise AccountError('同步记录已变化，请重新核对。')
                    rows[key]={**previous,'remote':remote,'observedAt':now};self.save(rows)
            why=decision(local,remote)
            if why:return {'state':'skipped','message':why,'remote':remote}
            token=secrets.token_hex(24)
            self.plans={k:v for k,v in self.plans.items() if now-v['created']<300000}
            if len(self.plans)>20:self.plans.clear()
            self.plans[token]={'account':account,'local':local,'remote':remote,'created':now}
            return {'state':'ready','token':token,'local':local,'remote':remote,'message':'确认后再次检查手机进度；有变化就跳过。'}
        if action!='progress_commit':raise AccountError('不支持的进度操作')
        plan=self.plans.pop(request.get('token',''),None)
        if not plan or plan['account']!=account or now-plan['created']>300000:raise AccountError('同步预览已过期，请重新检查手机进度。')
        if 'consentToken' in plan:self.consent(plan['consentToken'],account,plan['local']['seriesId'],now)
        local=plan['local'];validate(local,now)
        remote=self.read(flow,local['seriesId'])
        why=decision(local,remote,plan['remote'],True)
        if why:return {'state':'skipped','message':why,'remote':remote}
        rows=self.journal();key=account+':'+local['seriesId']
        if rows.get(key,{}).get('state')=='unknown':return {'state':'unknown','message':'上次同步尚未确认，请在手机核对。'}
        rows[key]={'state':'unknown','stage':'history_dispatched','local':local,'at':now};self.save(rows)
        # The durable uncertain record precedes either POST. Never replay after
        # crash/timeout, and never label acknowledgements as phone acceptance.
        try:
            payloads=bodies(local)
            self.send(flow,UPDATE,payload=payloads[UPDATE])
            rows[key]['stage']='history_ack';self.save(rows)
            between=self.read(flow,local['seriesId'])
            own=matches(local,between)
            if not own and between!=remote:
                return {'state':'unknown','message':'手机历史读回不一致，已停止后续上传；本地记录已保留。'}
            rows[key]['stage']='progress_dispatched';self.save(rows)
            self.send(flow,UPLOAD,payload=payloads[UPLOAD])
            rows[key]['stage']='progress_ack';self.save(rows)
            after=self.read(flow,local['seriesId'])
            if not matches(local,after):return {'state':'unknown','message':'进度提交后读回不一致，请在手机核对。'}
            rows[key]['state']='readback';self.save(rows)
            return {'state':'readback','message':'云端历史已读回一致。请打开手机红果确认能从这里续播。','local':local,'remote':after}
        except Exception:
            return {'state':'unknown','message':'进度上传结果尚未确认，已停止重复上传。登录和本地记录已保留。'}


def matches(local, remote):
    return bool(remote and remote['videoId']==local['videoId'] and remote['index']==local['episode']-1
        and abs(remote['positionMs']-local['positionMs'])<=1000 and remote['updatedAtMs']==local['watchedAtMs'])
