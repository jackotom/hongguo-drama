"""Single-item reservation preparation and confirmation. Not wired into the account host yet.

The host must bind account identity and provide one signed sender plus read-only
pages. This module has no HTTP client, login initialization, or background work.
"""
import gzip,json,re
from urllib.parse import urlsplit
from phone_account_favorites import classify_response,request_context,reading_minimal_headers,FavoriteError
from phone_favorite_journal import FavoriteJournal

HOST='api5-normal-lq.fqnovel.com'
PATH='/reading/bookapi/search/uncover_subscribe/v'

class ReservationError(ValueError):pass

def identity(value):
    return isinstance(value,str) and re.fullmatch(r'[1-9][0-9]{7,18}',value) is not None and int(value)<=9223372036854775807

def validate(request):
    if not isinstance(request,dict) or set(request)!={'itemId','reserved','requestId'}:
        raise ReservationError('预约参数无效，尚未提交')
    if not identity(request['itemId']) or type(request['reserved']) is not bool:
        raise ReservationError('预约对象或目标状态无效')
    if not isinstance(request['requestId'],str) or not re.fullmatch(r'[a-zA-Z0-9-]{16,64}',request['requestId']):
        raise ReservationError('预约操作标识无效')
    return request

def make_body(request):
    validate(request)
    return {'item_id':request['itemId'],'item_type':1,'op_type':1 if request['reserved'] else 2,
            'wish_list_all_del':0,'shark_param':{'enter_from':'BulletActivity','previous_page':'MainFragmentActivity',
            'page_list':'MainFragmentActivity,BulletActivity'}}

def prepare(context,request,now_ms):
    if type(now_ms) is not int or not 946684800000<=now_ms<=4102444800000:raise ReservationError('系统时间异常')
    from phone_account_social import sign
    body=gzip.compress(json.dumps(make_body(request),separators=(',',':')).encode(),compresslevel=6,mtime=0)
    url,headers=sign(request_context(context),body,now_ms=now_ms,path=PATH)
    from phone_account_transport import ORIGIN
    parts=urlsplit(url)
    if parts.scheme!='https' or parts.netloc!=urlsplit(ORIGIN).netloc or parts.path!=PATH or not parts.query or parts.fragment:
        raise ReservationError('预约签名路由异常，尚未提交')
    headers=reading_minimal_headers(headers);headers['Content-Encoding']='gzip'
    return 'https://'+HOST+PATH+'?'+parts.query,headers,body

class ReservationJournal(FavoriteJournal):
    """Reuse encrypted membership receipts in a separate, reservation-only file.

    The private storage schema's seriesId/favorite represent itemId/reserved.
    No existing favorite receipt file is opened or modified.
    """
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.path=self.path.with_name('account-reservation-attempts.dpapi')

def public(row):
    messages={'verified':'已读取确认手机预约状态。','rejected':'红果未接受此次预约操作。',
              'unknown':'预约结果尚未确认，请先核对，勿重复提交。','acknowledged':'预约已提交，等待手机片单确认。'}
    return {'requestId':row['requestId'],'itemId':row['seriesId'],'reserved':row['favorite'],
            'state':row['state'],'message':messages[row['state']]}

def observed_membership(read_page,item_id,max_pages=3):
    """A positive exact item ID is enough; absence requires both complete partitions."""
    if not identity(item_id) or type(max_pages) is not int or not 1<=max_pages<=3:raise ReservationError('预约核对参数无效')
    remaining=max_pages;complete=True
    try:
        for online in (False,True):
            offset=0
            while True:
                if remaining==0:return None
                remaining-=1;page=read_page(online,offset)
                if not isinstance(page,dict) or page.get('kind')!='reservations' or type(page.get('online')) is not bool or page['online']!=online or page.get('offset')!=offset:return None
                if not isinstance(page.get('items'),list) or type(page.get('hasMore')) is not bool:return None
                for item in page['items']:
                    target=item.get('reservationId') if isinstance(item,dict) else None
                    if not identity(target):complete=False
                    if target==item_id:return True
                if page.get('unsupportedCount',0):complete=False
                if not page['hasMore']:break
                nxt=page.get('nextOffset')
                if type(nxt) is not int or not offset<nxt<=2000:return None
                offset=nxt
        return False if complete else None
    except Exception:return None

def reconcile(account,request_id,journal,read_page):
    row=journal.find(account,request_id)
    if row is None:raise ReservationError('未找到当前账号的预约记录')
    if row['state'] in ('verified','rejected'):return public(row)
    observed=observed_membership(read_page,row['seriesId'])
    if type(observed) is bool and observed==row['favorite']:
        try:row=journal.finish(account,request_id,'verified')
        except FavoriteError:pass
    return public(row)

def change(account,request,journal,send,read_page,*,enabled=False):
    if enabled is not True:raise ReservationError('手机预约写入尚未启用')
    validate(request)
    if not isinstance(account,str) or not re.fullmatch(r'[a-f0-9]{64}',account):raise ReservationError('账号身份无效')
    # Validate before the durable unknown receipt; reserve before any actual send.
    payload=make_body(request)
    row,fresh=journal.begin(account,{'seriesId':request['itemId'],'favorite':request['reserved'],'requestId':request['requestId']})
    if not fresh:return public(row)
    try:state=classify_response(send(payload))
    except Exception:state='unknown'
    try:row=journal.finish(account,request['requestId'],state)
    except FavoriteError:return public(row)
    if state=='rejected':return public(row)
    return reconcile(account,request['requestId'],journal,read_page)
