"""Single-series follow intent and durable confirmation; no network/account adapter.

The public wire fields were observed with synthetic IDs in the 1.2.23 reference.
Own journal and readback semantics are reused; album follow is a separate scope.
"""
import re
from phone_account_favorites import classify_response, FavoriteError
from phone_favorite_journal import FavoriteJournal
from phone_reservation import identity

PATH = '/novel/articleapi/do_action/v1/'


class FollowingError(ValueError):
    pass


def validate(request):
    if not isinstance(request, dict) or set(request) != {'seriesId', 'following', 'requestId'}:
        raise FollowingError('追更参数无效，尚未提交。')
    if not identity(request['seriesId']) or type(request['following']) is not bool:
        raise FollowingError('追更剧目或目标状态无效。')
    if not isinstance(request['requestId'], str) or not re.fullmatch(r'[a-zA-Z0-9-]{16,64}', request['requestId']):
        raise FollowingError('追更操作标识无效。')
    return request


def make_body(request):
    validate(request)
    return {'action_type': 34 if request['following'] else 35,
            'object_id': request['seriesId'], 'object_type': 10,
            'business_param': {'book_id': 0, 'has_aigc_content': False, 'modify_count': 0,
                               'shark_param': {'enter_from': 'MainFragmentActivity',
                                               'previous_page': '', 'page_list': 'MainFragmentActivity'}}}


class FollowingJournal(FavoriteJournal):
    """A separate encrypted file; generic internal membership fields stay private."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.path = self.path.with_name('account-following-attempts.dpapi')


def public(row):
    messages = {'verified': '已读取确认手机追更状态。',
                'rejected': '红果未接受此次追更操作。',
                'unknown': '追更结果尚未确认，请先核对，勿重复提交。',
                'acknowledged': '追更操作已提交，等待手机片单确认。'}
    return {'requestId': row['requestId'], 'seriesId': row['seriesId'], 'following': row['favorite'],
            'state': row['state'], 'message': messages[row['state']]}


def observed_membership(read_page, series_id, max_pages=3):
    """Observe direct series follows only. An album child is not a direct follow.

    Exact presence suffices; absence requires complete, consistent pagination.
    No retries, unbounded traversal, or interpreting an error as an empty list.
    """
    if not identity(series_id) or type(max_pages) is not int or not 1 <= max_pages <= 3:
        raise FollowingError('追更核对参数无效。')
    cursor = ''; visited = set(); seen = set(); seen_albums = set()
    try:
        for _ in range(max_pages):
            page = read_page(cursor)
            if not isinstance(page, dict) or not isinstance(page.get('items'), list) or len(page['items']) > 200:
                return None
            if type(page.get('hasMore')) is not bool or not isinstance(page.get('albums', []), list) or page.get('unsupportedCount', 0) != 0:
                return None
            if len(page.get('albums', [])) > 200:
                return None
            for album in page.get('albums', []):
                if (not isinstance(album, dict) or not identity(album.get('albumId'))
                        or album['albumId'] in seen_albums or not isinstance(album.get('items'), list)
                        or len(album['items']) > 1000
                        or any(not isinstance(child, dict) or not identity(child.get('seriesId')) for child in album['items'])):
                    return None
                seen_albums.add(album['albumId'])
            found = False
            for item in page['items']:
                target = item.get('seriesId') if isinstance(item, dict) else None
                if not identity(target) or target in seen:
                    return None
                seen.add(target)
                found = found or target == series_id
            if found:
                return True
            if not page['hasMore']:
                return False
            next_cursor = page.get('cursor')
            if (not isinstance(next_cursor, str) or not next_cursor or len(next_cursor) > 2048
                    or any(ord(c) < 32 or ord(c) == 127 for c in next_cursor)
                    or next_cursor == cursor or next_cursor in visited
                    or not (page['items'] or page.get('albums'))):
                return None
            visited.add(cursor); cursor = next_cursor
    except Exception:
        return None
    return None


def reconcile(account, request_id, journal, read_page):
    row = journal.find(account, request_id)
    if row is None:
        raise FollowingError('未找到当前账号的追更记录。')
    if row['state'] in ('verified', 'rejected'):
        return public(row)
    observed = observed_membership(read_page, row['seriesId'])
    if type(observed) is bool and observed == row['favorite']:
        try:
            row = journal.finish(account, request_id, 'verified')
        except FavoriteError:
            pass
    return public(row)


def change(account, request, journal, send, read_page, *, enabled=False):
    if enabled is not True:
        raise FollowingError('手机追更写入尚未启用。')
    payload = make_body(request)
    if not isinstance(account, str) or not re.fullmatch(r'[a-f0-9]{64}', account):
        raise FollowingError('账号身份无效，未更改手机追更。')
    # Reserve before invoking the sender. A timeout remains durable across restart.
    row, fresh = journal.begin(account, {'seriesId': request['seriesId'], 'favorite': request['following'], 'requestId': request['requestId']})
    if not fresh:
        return public(row)
    try:
        state = classify_response(send(payload))
    except Exception:
        state = 'unknown'
    try:
        row = journal.finish(account, request['requestId'], state)
    except FavoriteError:
        return public(row)
    if state == 'rejected':
        return public(row)
    return reconcile(account, request['requestId'], journal, read_page)
