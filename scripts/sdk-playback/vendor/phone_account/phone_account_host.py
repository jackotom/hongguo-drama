"""Private pipe protocol; no TCP listener, credential logs or automatic SMS."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import json
import re
from phone_account_flow import AccountFlow, AccountError
from phone_account_transport import AccountTransport, LIBRARY, HOST, FAVORITES_PATH
from phone_account_device import initialize_for_login as initialize, InitializationError
from phone_account_session import SessionStore, LibraryCache


class AccountHost:
    def __init__(self, device_path, transport_factory=AccountTransport, initializer=initialize, store_factory=SessionStore):
        self.device_path = Path(device_path)
        self.transport_factory, self.initializer = transport_factory, initializer
        self.store_factory = store_factory
        self.flow = AccountFlow(transport_factory(self.device_path))
        self.social_attempts = {}
        self.store = store_factory(self.device_path)
        self.library_cache = LibraryCache(self.device_path)
        self.store.load(self.flow, HOST)

    def persist(self):
        try: self.store.save(self.flow)
        except Exception:
            self.store.saved = False
            self.store.notice = '当前已登录，但无法保存到本机；退出应用后可能需要重新登录。'

    def forget(self):
        try:
            self.store.clear()
            self.library_cache.clear()
            self.store.notice = ''
        except Exception:
            self.store.notice = '当前会话已退出，但本机保存状态清除失败，请重试退出清除。'
            raise AccountError(self.store.notice) from None
        finally: self.flow.cancel()

    def status(self):
        self.store.expire(self.flow)
        if not self.flow.uid:self.clear_progress_consent()
        value = self.flow.status()
        value.update(rememberLogin=self.store.remember, sessionSaved=self.store.saved, sessionNotice=self.store.notice)
        # A fresh installation is usable without registering merely by opening
        # the app. Component/context validation still happens locally.
        if self.flow.transport.context is None:
            value['loginAvailable'] = True
        else:
            try:
                self.flow.transport.ready()
                value['loginAvailable'] = True
            except AccountError as error:
                value.update(loginAvailable=False, unavailableReason=str(error))
        return value

    def clear_progress_consent(self):
        if hasattr(self,'progress_sync'):
            self.progress_sync.consents.clear()
            self.progress_sync.plans.clear()

    def handle(self, request):
        action = request.get('action')
        if action in ('qr_start', 'qr_poll', 'qr_status', 'qr_cancel', 'qr_commit'):
            from phone_account_qr_login import QRLoginController
            if not hasattr(self, 'qr_login'):
                self.qr_login = QRLoginController()
            return self.qr_login.handle(self, request)
        if action == 'status':
            return self.status()
        if action == 'remember':
            try:
                self.store.preference(request.get('enabled'), self.flow)
                if not self.store.remember: self.library_cache.clear()
            except Exception: raise AccountError('无法更新本机登录保存设置，请重试。') from None
            return self.status()
        self.store.expire(self.flow)
        if not self.flow.uid or action in ('send','login','continue','logout'):
            self.clear_progress_consent()
        if action in ('library_cache_load','library_cache_save'):
            enabled=bool(self.flow.uid and self.store.saved and self.store.remember)
            if action=='library_cache_load':
                return self.library_cache.load(self.flow,HOST,enabled)
            if not enabled:
                self.library_cache.clear()
                return False
            try: self.library_cache.save(self.flow,HOST,request.get('library'))
            except Exception: raise AccountError('已读取手机片单，但本机副本暂未保存。') from None
            return True
        if action == 'send':
            phone = request.get('phone')
            if not isinstance(phone, str) or not re.fullmatch(r'1[0-9]{10}', phone):
                raise AccountError('请输入中国大陆 11 位手机号')
            if self.flow.transport.context is None:
                # Only this explicit user action may register. The initializer's
                # durable attempt marker prevents replay after unknown results.
                try:
                    self.initializer(self.device_path)
                    self.flow.transport.client.close()
                    self.flow = AccountFlow(self.transport_factory(self.device_path))
                except InitializationError as error:
                    code = str(error)
                    if code == 'registration-preflight-failed':
                        message = '本机账号组件或加密准备失败，尚未发起设备注册或短信请求。请修复安装后再获取验证码，无需删除用户数据。'
                    elif code == 'previous-registration-needs-review':
                        message = '此前的设备注册结果需要核对，本次未重复注册，也未发送验证码。请通过设置中的诊断反馈，保留现有用户数据。'
                    elif code == 'registration-retry-cooldown':
                        message = '设备准备尚未成功，请稍等一分钟后重新获取验证码。本次未发短信，原登录和本地记录已保留。'
                    elif code == 'registration-in-progress':
                        message = '设备正在准备，请稍候再试。本次未重复注册或发送短信。'
                    elif code in ('registration-http-rejected','device-not-issued','invalid-registration-response','response-too-large'):
                        message = '设备注册未返回有效结果，未发送验证码。请通过设置中的诊断反馈，勿连续重试；已有登录和本地记录不受影响。'
                    else:
                        message = '账号设备准备未完成，未发送验证码；请通过设置中的诊断反馈，勿连续重试'
                    raise AccountError(message) from None
            self.flow.send_code(phone)
        elif action == 'login':
            self.flow.login(request.get('phone'), request.get('code'))
        elif action == 'continue':
            self.flow.continue_verification()
        elif action == 'logout':
            if hasattr(self, 'qr_login'):
                self.qr_login.cancel()
            self.forget()
        elif action == 'social':
            from phone_account_social import publish
            images = None
            if request.get('pictureIds'):
                from phone_picture_journal import resolve
                images = resolve(self.flow,request['pictureIds'],request.get('pictureContextId'),self.device_path)
            result = publish(self.flow, request, self.social_attempts) if images is None else publish(self.flow, request, self.social_attempts, pictures=images)
            self.persist()
            return result
        elif action in ('picture_status','picture_upload'):
            from phone_picture_journal import handle
            return handle(self.flow,request,self.device_path)
        elif action in ('social_like', 'social_like_status'):
            from phone_social_likes import LikeJournal, react, status
            journal = LikeJournal(self.device_path)
            return (react if action == 'social_like' else status)(self.flow, request, journal)
        elif action in ('author_follow_change','author_follow_status'):
            from phone_author_follow import handle
            return handle(self.flow,request,self.device_path)
        elif action in ('comment_delete','comment_delete_status'):
            from phone_comment_delete import handle
            return handle(self.flow,request,self.device_path)
        elif action in ('favorite','favorite_confirm','favorite_pending'):
            from phone_account_favorites import mutate, reconcile, pending, FavoriteError
            from phone_favorite_journal import FavoriteJournal
            try:
                journal=FavoriteJournal(self.device_path)
                if action=='favorite_pending':return pending(self.flow,journal)
                if action=='favorite_confirm':return reconcile(self.flow,request.get('requestId'),request.get('observed'),journal)
                result=mutate(self.flow,request,journal)
                self.persist()
                return result
            except FavoriteError as error:
                raise AccountError(str(error)) from None
        elif action in ('reservation','reservation_confirm','reservation_status'):
            from phone_reservation_transport import handle
            from phone_reservation import ReservationError,FavoriteError
            try:return handle(self.flow,request,self.device_path)
            except (ReservationError,FavoriteError):
                raise AccountError('手机预约操作未完成，请核对片单；登录和本地记录已保留。') from None
        elif action in ('progress_preview','progress_commit','progress_enable','progress_disable','progress_auto_preview'):
            from phone_progress_sync import ProgressSync
            if not hasattr(self, 'progress_sync'):self.progress_sync=ProgressSync(self.device_path)
            return self.progress_sync.handle(self.flow,request)
        elif action == 'optional_list':
            from phone_optional_lists import fetch
            return fetch(self.flow,request.get('kind'),request.get('offset',0),request.get('online',False))
        elif action == 'following':
            from phone_account_following import fetch_page
            return fetch_page(request.get('cursor', ''), lambda path, query:
                              self.handle({'action': 'library', 'path': path, 'query': query}))
        elif action in ('following_status','following_change','following_confirm'):
            from phone_following_transport import handle
            from phone_following_actions import FollowingError,FavoriteError
            try:return handle(self.flow,request,self.device_path)
            except (FollowingError,FavoriteError):
                raise AccountError('手机追更操作未完成，请核对片单；登录和本地记录已保留。') from None
        elif action == 'library':
            if not self.flow.uid:
                raise AccountError('请先登录红果账号')
            if request.get('path') not in LIBRARY:
                raise AccountError('不支持的云片单操作')
            result = self.flow.transport.request(request['path'], extra=request.get('query'))
            data = result.get('data') if isinstance(result,dict) else None
            codes = [result.get('code'),result.get('error_code')] if isinstance(result,dict) else []
            if isinstance(data,dict): codes.append(data.get('error_code'))
            if any(str(code)=='1009' for code in codes):
                if request['path']==FAVORITES_PATH:
                    raise AccountError('手机收藏读取未获授权，请稍后重试；当前登录已保留。', '1009')
                self.forget()
                self.store.notice = '红果账号会话已过期，请重新登录。'
                raise AccountError(self.store.notice, '1009')
            if request['path']!=FAVORITES_PATH: self.persist()
            return result
        else:
            raise AccountError('不支持的账号操作')
        if self.flow.uid: self.persist()
        return self.status()


def main():
    # Parent supplies only a protected-device path on stdin after owning the child.
    first=sys.stdin.buffer.readline(32768)
    try:
        init=json.loads(first)
        host=AccountHost(init['devicePath'])
        unavailable=''
    except Exception:
        host=None;unavailable='账号运行组件或独立设备资料不可用，请检查候选版'
    while True:
        line=sys.stdin.buffer.readline(12*1024*1024+1)
        if not line:break
        if len(line)>12*1024*1024:break
        try:
            request=json.loads(line);action=request.get('action')
            if len(line) > (12*1024*1024 if action=='picture_upload' else 4*1024*1024 if action=='library_cache_save' else 65536):
                raise AccountError('账号请求过大')
            if host is None:
                if action!='status':raise AccountError(unavailable)
                result={'authenticated':False,'loginAvailable':False,'unavailableReason':unavailable,'displayName':'','retryAfter':0,'phase':'unavailable'}
            else:result=host.handle(request)
            reply={'ok':True,'value':result}
        except AccountError as e:reply={'ok':False,'error':str(e)}
        except Exception:reply={'ok':False,'error':'账号操作未完成，请重新打开账号页检查状态'}
        sys.stdout.write(json.dumps(reply,ensure_ascii=True,separators=(',',':'))+'\n');sys.stdout.flush()
    if host:
        if hasattr(host, 'qr_login'):host.qr_login.cancel()
        host.flow.cancel()


if __name__=='__main__':main()
