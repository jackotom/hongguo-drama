"""Independent read-only phone-following page; no remote mutations or retries."""
import re
import time
from phone_account_flow import AccountError

PATH = '/novel/articleapi/relation/get_user_action/v1/'

def cursor_value(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise AccountError('追更分页位置无效，请重新读取')
    return value or '0'

def parse_page(root, previous='0'):
    if not isinstance(root, dict) or str(root.get('code')) != '0':
        raise AccountError('手机追更读取未完成，已保留上次记录')
    data = root.get('data')
    if not isinstance(data, dict): raise AccountError('手机追更响应缺少数据')
    if str(data.get('error_code', 0)) != '0': raise AccountError('红果未接受此次追更读取，已保留上次记录')
    rows, info = data.get('mix_data'), data.get('comment_list_info')
    if not isinstance(rows, list) or len(rows) > 200 or not isinstance(info, dict) or type(info.get('has_more')) is not bool:
        raise AccountError('手机追更格式尚未识别，已保留上次记录')
    more = info['has_more']
    if more and (not isinstance(info.get('cursor'), str) or not info['cursor']):
        raise AccountError('手机追更缺少下一页位置')
    cursor = cursor_value(info.get('cursor', '')) if more else ''
    if more and (not rows or cursor == previous): raise AccountError('手机追更分页没有前进，请重新读取')
    items, albums, seen, album_seen = [], [], set(), set()
    nested_count = 0
    for row in rows:
        if not isinstance(row, dict): raise AccountError('手机追更条目尚未识别')
        if isinstance(row.get('album'), dict) and 'video' not in row:
            raw = row['album']; aid, title, videos = raw.get('album_id'), raw.get('album_name'), raw.get('album_video_list')
            if not isinstance(aid, str) or not re.fullmatch(r'[1-9][0-9]{7,23}', aid) or aid in album_seen:
                raise AccountError('手机追更合集标识异常')
            if not isinstance(title, str) or not title.strip() or not isinstance(videos, list) or len(videos)>1000:
                raise AccountError('手机追更合集格式尚未识别')
            nested_count += len(videos)
            if nested_count>2000: raise AccountError('追更合集条目过多，请稍后重试')
            children, child_seen = [], set()
            for video in videos:
                # Album entries are references: their video_id is not the series ID.
                # Resolve titles/counts lazily from the established metadata path.
                expand=video.get('expand') if isinstance(video,dict) else None
                reference=expand.get('series_id') if isinstance(expand,dict) else None
                if isinstance(reference,str) and re.fullmatch(r'[1-9][0-9]{7,23}',reference):
                    item={'seriesId':reference}
                    order=expand.get('series_in_album_order')
                    if type(order) is int and 0<order<=100000:item['order']=order
                else:item = parse_series(video)
                if item['seriesId'] in child_seen: raise AccountError('手机追更合集剧目重复')
                child_seen.add(item['seriesId']);children.append(item)
            album = {'albumId':aid,'title':title.strip()[:200],'items':children}
            total = raw.get('video_count')
            if type(total) is int and len(children)<=total<=100000: album['totalSeries']=total
            caught = raw.get('has_watched_latest_series_in_album')
            if type(caught) is bool: album['caughtUp']=caught
            album_seen.add(aid);albums.append(album)
        elif 'album' not in row:
            item = parse_series(row.get('video'))
            if item['seriesId'] in seen: raise AccountError('手机追更剧集标识异常')
            seen.add(item['seriesId']);items.append(item)
        else: raise AccountError('手机追更条目尚未识别')
    return {'items':items,'albums':albums,'cursor':cursor,'hasMore':more,'syncedAt':int(time.time())}


def parse_series(video):
    if not isinstance(video, dict): raise AccountError('手机追更条目尚未识别')
    common, expand = video.get('common'), video.get('expand')
    sid = video.get('video_id')
    if not isinstance(sid, str) or not re.fullmatch(r'[1-9][0-9]{7,23}', sid): raise AccountError('手机追更剧集标识异常')
    if not isinstance(common, dict) or not isinstance(expand, dict): raise AccountError('手机追更剧集信息不完整')
    title, total = common.get('title'), expand.get('episode_cnt')
    if not isinstance(title, str) or not title.strip() or type(total) is not int or not 0<total<=100000:
        raise AccountError('手机追更剧名或集数尚未识别')
    item={'seriesId':sid,'title':title.strip()[:200],'episodeCount':total}
    watched=expand.get('latest_watched_vid_index')
    if type(watched) is int and 0<watched<=total:item['lastEpisode']=watched
    caught=expand.get('has_watched_latest_episode')
    if type(caught) is bool:item['caughtUp']=caught
    return item


def fetch_page(cursor, read):
    cursor = cursor_value(cursor)
    return parse_page(read(PATH, {'action_channel': '9', 'count': '20', 'cursor_str': cursor}), cursor)
