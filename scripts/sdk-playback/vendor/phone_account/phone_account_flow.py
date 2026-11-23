"""Independent SMS/MFA state machine. No automatic SMS or verification polling.

The injected transport must own an isolated, fully signed account session. This
module never sees the playback client and never persists phone/OTP/challenges.
"""
from dataclasses import dataclass
import json
import re
import time

SEND = '/passport/mobile/send_code/v1/'
LOGIN = '/passport/mobile/sms_login/'
VERIFY = '/passport/upsms/verify/'
USER = '/reading/user/info/v1/'


class AccountError(Exception):
    """Only fixed, credential-free messages may reach the UI."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def mixed(value):
    return bytes(byte ^ 5 for byte in value.encode()).hex()


def identifier(value):
    return str(value) if isinstance(value, (str, int)) and re.fullmatch(r'[0-9]{5,30}', str(value)) and int(value) else ''


def checked(root, stage='account'):
    if not isinstance(root, dict):
        raise AccountError('账号响应格式异常')
    data = root.get('data')
    codes=[value for value in ((data.get('error_code') if isinstance(data, dict) else None),root.get('error_code'),root.get('code')) if value is not None]
    code=next((value for value in codes if str(value)!='0'),codes[0] if codes else None)
    if root.get('message')=='error' or (str(code) != '0' and not (code is None and root.get('message')=='success')):
        messages = {'7': '红果暂时拒绝此次请求，请勿连续重试',
                    '14': '账号签名或客户端参数未被红果接受',
                    '2003': '验证码无效或已过期，请核对后重试',
                    '1009': '账号会话已过期，请重新登录'}
        # Only a short numeric business code and a local stage label may leave
        # this boundary. Upstream descriptions can contain account credentials.
        safe_code = str(code) if type(code) in (str, int) and re.fullmatch(r'-?[0-9]{1,6}', str(code)) else None
        label = {'send': '获取验证码', 'login': '验证码登录', 'verify': '确认手机验证',
                 'resume': '验证后登录', 'profile': '核对登录账号'}.get(stage, '账号操作')
        message = messages.get(safe_code, '红果未接受此次账号操作')
        if stage == 'verify' and safe_code == '1045':
            message = '红果尚未确认手机验证；如已发送，请勿重复发短信，稍后再确认'
        detail = label + ('；错误码 ' + safe_code if safe_code is not None else '；未提供有效错误码')
        raise AccountError(message + '（' + detail + '）', safe_code)
    if not isinstance(data, dict):
        raise AccountError('账号响应缺少资料')
    return data


def short_text(value, maximum=4096):
    return value if isinstance(value, str) and 0 < len(value) <= maximum else ''


@dataclass(repr=False)
class Challenge:
    encrypt_uid: str
    sms_code_key: str
    mobile_ticket: str
    log_id: str
    destination: str
    sms_content: str
    expires: float


def parse_challenge(root, now):
    """Only explicit upstream upsms challenges can enter the continuation state."""
    if not isinstance(root, dict) or not isinstance(root.get('data'), dict):
        return None
    data = root['data']
    uid, key = short_text(data.get('encrypt_uid')), short_text(data.get('sms_code_key'))
    if not uid or not key:
        return None
    ways = data.get('verify_ways')
    if not isinstance(ways, list) or len(ways) > 10:
        raise AccountError('红果要求额外验证，但未提供可用的验证方式')
    for way in ways:
        if not isinstance(way, dict) or 'channel_mobile' not in way or 'sms_content' not in way:
            continue
        destination = way.get('channel_mobile')
        if isinstance(destination, list) and destination:
            destination = destination[0]
        content = short_text(way.get('sms_content'), 500)
        if not isinstance(destination, str) or not re.fullmatch(r'\+?[0-9]{3,20}', destination) or not content:
            raise AccountError('红果的手机验证指引不完整，请重新登录')
        event = data.get('event_params', {})
        if isinstance(event, str):
            try:
                event = json.loads(event) if len(event) <= 8192 else {}
            except ValueError:
                event = {}
        log_id = short_text(event.get('log_id')) if isinstance(event, dict) else ''
        return Challenge(uid, key, short_text(data.get('mobile_ticket')), log_id,
                         destination, content, now + 300)
    raise AccountError('红果要求的验证方式尚不支持，请在手机红果检查账号状态')


class AccountFlow:
    """Serialize operations in the host. Each user action makes at most one SMS call.

    Transport contract: ready(), request(path, form=None), authenticated_cookies(),
    reset(). A network timeout has unknown outcome and is never silently retried.
    """
    def __init__(self, transport, clock=time.monotonic):
        self.transport, self.clock = transport, clock
        self.phase, self.phone, self.code, self.uid, self.name = 'idle', '', '', '', ''
        self.next_send = self.next_verify = self.code_expires = 0
        self.challenge = None
        self.mobile_ticket = ''

    def status(self):
        now = self.clock()
        if self.challenge and now >= min(self.challenge.expires, self.code_expires):
            self._clear_pending()
            self.phase = 'expired'
        value = {'authenticated': bool(self.uid), 'phase': self.phase,
                 'displayName': self.name, 'retryAfter': max(0, int(self.next_send-now+0.999))}
        # UI-only instructions. Never put this payload in logs or evidence receipts.
        if self.challenge:
            value['verification'] = {'kind': 'upsms', 'destination': self.challenge.destination,
                                     'content': self.challenge.sms_content,
                                     'expiresIn': max(0, int(min(self.challenge.expires, self.code_expires)-now))}
        return value

    def _clear_pending(self):
        self.phone = self.code = self.mobile_ticket = ''
        self.code_expires = 0
        self.challenge = None

    def cancel(self):
        # Keep SMS cooldown even if the user cancels or logs out.
        self._clear_pending()
        self.uid = self.name = ''
        self.transport.reset()
        self.phase = 'idle'
        return self.status()

    def send_code(self, phone):
        if not isinstance(phone, str) or not re.fullmatch(r'1[0-9]{10}', phone):
            raise AccountError('请输入中国大陆 11 位手机号')
        self.transport.ready()  # Must precede collecting state or sending anything.
        if self.uid:
            raise AccountError('请先退出当前账号')
        now = self.clock()
        if now < self.next_send:
            raise AccountError('请等待倒计时结束再获取验证码')
        self._clear_pending()
        self.transport.reset()
        self.phone = phone
        self.next_send = now + 60
        self.phase = 'sending'
        form = {'auto_read': '0', 'account_sdk_source': 'app',
                'passport_support_flow': 'captcha,verify', 'unbind_exist': mixed('1'),
                'mix_mode': '1', 'mobile': mixed('+86'+phone), 'type': mixed('24')}
        try:
            data = checked(self.transport.request(SEND, form), 'send')
        except Exception:
            self._clear_pending()
            self.phase = 'send_failed_or_unknown'
            raise
        self.mobile_ticket = short_text(data.get('mobile_ticket'))
        retry = data.get('retry_time', 60)
        self.next_send = now + max(60, min(600, retry if isinstance(retry, int) else 60))
        self.code_expires = now + 300
        self.phase = 'code_sent'
        return self.status()

    def login(self, phone, code):
        self.transport.ready()
        now = self.clock()
        if self.phase != 'code_sent' or phone != self.phone:
            raise AccountError('请先成功获取此手机号的验证码')
        if now >= self.code_expires:
            self._clear_pending(); self.phase = 'expired'
            raise AccountError('验证码已过期，请重新获取')
        if not isinstance(code, str) or not re.fullmatch(r'[0-9]{4,8}', code):
            raise AccountError('请输入 4–8 位短信验证码')
        if now < self.next_verify:
            raise AccountError('请稍后再验证，避免重复提交')
        self.code, self.next_verify = code, now + 5
        try:
            return self._login_exchange()
        except Exception:
            self.code = ''
            raise

    def _login_exchange(self, retry=False):
        form = {'account_sdk_source': 'app', 'passport_support_flow': 'captcha,verify',
                'mix_mode': '1', 'mobile': mixed('+86'+self.phone), 'code': mixed(self.code)}
        if retry:
            if not self.challenge:
                raise AccountError('验证会话已失效')
            form.update(passport_mfa_retry_tag='1', sms_code_key=mixed(self.challenge.sms_code_key))
        root = self.transport.request(LOGIN, form)
        challenge = parse_challenge(root, self.clock())
        if challenge:
            self.challenge, self.phase = challenge, 'verification_required'
            return self.status()
        data = checked(root, 'resume' if retry else 'login')
        uid = identifier(data.get('user_id_str') or data.get('user_id'))
        if not uid or not self.transport.authenticated_cookies():
            raise AccountError('红果尚未返回完整的登录会话')
        # Passport's accepted OTP response, its explicit identity and the fresh
        # authenticated session establish login. The reading-profile endpoint
        # also serves anonymous/default profiles and is not an identity probe.
        # Its nickname/availability must not erase a successfully issued session.
        # Library access is still independently authenticated and checked by the
        # host, and never inferred from this login status alone.
        if 'user_id_str' in data and 'user_id' in data:
            if identifier(data['user_id_str']) != identifier(data['user_id']):
                raise AccountError('登录响应的账号身份不一致')
        self.uid = uid
        self.name = short_text(data.get('screen_name') or data.get('name'), 100) or '红果账号'
        self._clear_pending(); self.phase = 'authenticated'
        return self.status()

    def continue_verification(self):
        """User has completed the displayed official challenge on their phone."""
        self.transport.ready()
        now = self.clock()
        if not self.challenge or self.phase != 'verification_required':
            raise AccountError('没有待续接的手机验证')
        if now >= min(self.challenge.expires, self.code_expires):
            self._clear_pending(); self.phase = 'expired'
            raise AccountError('验证已过期，请重新登录')
        if now < self.next_verify:
            raise AccountError('请稍后再确认手机验证')
        self.next_verify = now + 5
        challenge = self.challenge
        form = {'verify_ticket': '', 'new_verify_flow': '',
                'verify_scene': 'sms_login', 'verify_reason': 'ato', 'copywriting_key': 'sms_login',
                'ies_safety_diversion_tag': 'mfa', 'new_authn_sdk_version': '1.1.31',
                'new_authn_sdk_verify_reason': 'ato', 'new_authn_sdk_verify_scene': 'sms_login',
                'request_tag_from': 'h5', 'encrypt_uid': challenge.encrypt_uid,
                'biz_params': json.dumps({'passport_mfa_retry_tag': '1', 'sms_code_key': challenge.sms_code_key}, separators=(',', ':')),
                'new_authn_sdk_log_id': challenge.log_id}
        # Only an accepted verification can trigger the single login continuation.
        data = checked(self.transport.request(VERIFY, form), 'verify')
        if not short_text(data.get('ticket') or data.get('verify_ticket')):
            raise AccountError('红果尚未确认手机验证，请完成后再点继续')
        return self._login_exchange(retry=True)
