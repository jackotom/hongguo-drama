"""Isolated Hongguo web QR challenge. No existing desktop credentials are read.

This module owns challenge creation and status reads. Account verification and
import remain separate; a QR image or confirmation never implies authentication.
"""
from dataclasses import dataclass, field
import http.cookiejar
import json
import re
import secrets
import time
import threading
import urllib.parse
import urllib.request
import urllib.error

ORIGIN = 'https://hongguoduanju.com'
START_PATH = '/passport/web/get_qrcode/'
POLL_PATH = '/passport/web/check_qrconnect/'
IDENTITY_PATH = '/passport/account/info/v2/'
MAX_BODY = 256 * 1024
LOGIN_COOKIE_NAMES = frozenset(('sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard',
                              'uid_tt', 'uid_tt_ss', 'passport_csrf_token',
                              'passport_csrf_token_default'))


def callback_address(address):
    if not isinstance(address, str) or not 0 < len(address) <= 8192 or any(ord(c) < 33 for c in address):
        raise QRUnavailable('手机确认地址不可用，请重新获取二维码。')
    try:
        uri = urllib.parse.urlsplit(address)
        valid = uri.scheme == 'https' and uri.hostname == 'hongguoduanju.com' and uri.port in (None, 443) and not uri.username and not uri.password and not uri.fragment
    except ValueError:
        valid = False
    if not valid:
        raise QRUnavailable('手机确认地址不可用，请重新获取二维码。')
    return address


@dataclass(repr=False, frozen=True)
class QRCredentials:
    """Private fresh material, not proof of a verified account identity."""
    cookies: tuple = field(repr=False)
    token: str = field(default='', repr=False)


@dataclass(repr=False, frozen=True)
class QRAccount:
    """Passport-verified identity and the same isolated jar's current session."""
    uid: str
    name: str
    credentials: QRCredentials = field(repr=False)


def account_identity(value):
    """Only the Passport account response establishes identity, never a nickname."""
    if not isinstance(value, dict) or value.get('message') != 'success':
        raise QRUnavailable('扫码账号身份尚未确认，原登录已保留。')
    data = value.get('data')
    if not isinstance(data, dict):
        raise QRUnavailable('扫码账号资料不完整，原登录已保留。')
    for obj in (value, data):
        for key in ('error_code', 'code'):
            if key in obj and (type(obj[key]) is not int or obj[key] != 0):
                raise QRUnavailable('扫码账号身份尚未确认，原登录已保留。')
    ids = []
    for key in ('user_id_str', 'user_id'):
        if key in data:
            raw = data[key]
            if type(raw) not in (str, int) or not re.fullmatch(r'[1-9][0-9]{4,29}', str(raw)):
                raise QRUnavailable('扫码账号身份无效，原登录已保留。')
            ids.append(str(raw))
    if not ids or len(set(ids)) != 1:
        raise QRUnavailable('扫码账号身份不一致，原登录已保留。')
    name = data.get('screen_name') or data.get('name')
    if not isinstance(name, str) or not 0 < len(name) <= 100 or any(ord(c) < 32 for c in name):
        name = '红果账号'
    return ids[0], name


class QRUnavailable(RuntimeError):
    """Fixed public message; no challenge, cookie or server text in exceptions."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def start_parameters(now):
    return {
        'aid': '513755', 'language': 'zh', 'account_sdk_source': 'web',
        'is_from_ttaccountsdk': '1', 'passport_jssdk_version': '2.4.13',
        'passport_jssdk_type': 'normal', 'p_js_v': '2.4.13',
        'p_js_t': 'pro', 'p_zt': '3.3.5', 'p_ver': '1.0.29',
        'p_bd': '1.0.1.20', 'request_host': urllib.parse.quote(ORIGIN, safe=''),
        'next': ORIGIN, 'ts': str(int(now * 1000)),
    }


def parse_response(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BODY:
        raise QRUnavailable('二维码响应不可用，请稍后重试。')
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise QRUnavailable('二维码响应不可用，请稍后重试。') from None
    if not isinstance(value, dict):
        raise QRUnavailable('二维码响应不可用，请稍后重试。')
    return value


class QRTransport:
    """Ephemeral cookie jar belongs only to this anonymous QR conversation."""
    def __init__(self):
        self.closed = False
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())

    def start(self, params):
        return self._get(START_PATH, params)

    def poll(self, params):
        return self._get(POLL_PATH, params)

    def verify(self, params, credentials):
        # No other account/domain/transport participates in this query. A caller
        # cannot attach arbitrary credentials: they must match this private jar.
        if not isinstance(credentials, QRCredentials) or self._credentials(credentials.token) != credentials:
            raise QRUnavailable('扫码会话已变化，原登录已保留。')
        value = self._get(IDENTITY_PATH, params)
        uid, name = account_identity(value)
        return QRAccount(uid, name, self._credentials(credentials.token))

    def _get(self, path, params):
        if self.closed:
            raise QRUnavailable('二维码会话已取消。')
        if path not in (START_PATH, POLL_PATH, IDENTITY_PATH):
            raise QRUnavailable('二维码请求不可用。')
        url = ORIGIN + path + '?' + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, headers={
            'Accept': 'application/json', 'Referer': ORIGIN + '/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        })
        try:
            with self.opener.open(request, timeout=15) as response:
                if response.status != 200:
                    raise QRUnavailable('二维码暂时无法获取，请稍后重试。')
                value = parse_response(response.read(MAX_BODY + 1))
                if self.closed:
                    self.jar.clear()
                    raise QRUnavailable('二维码会话已取消。')
                return value
        except QRUnavailable:
            raise
        except Exception:
            raise QRUnavailable('二维码暂时无法获取，请稍后重试。') from None
        finally:
            # A late response can add cookies even after close() cleared the jar.
            # Clear on both successful and exceptional completion after cancel.
            if self.closed:
                self.jar.clear()

    def close(self):
        self.closed = True
        self.jar.clear()

    def _credentials(self, token=''):
        if self.closed:
            raise QRUnavailable('二维码会话已取消。')
        cookies = {}
        for item in self.jar:
            if item.domain.lstrip('.').lower() != 'hongguoduanju.com' or item.name not in LOGIN_COOKIE_NAMES or item.is_expired():
                continue
            if item.name in cookies and cookies[item.name] != item.value:
                raise QRUnavailable('手机确认返回了冲突的会话，请重新获取二维码。')
            cookies[item.name] = item.value
        for value in [token, *cookies.values()]:
            if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 33 or ord(c) > 126 or c == ';' for c in value):
                raise QRUnavailable('手机确认会话不可用，请重新获取二维码。')
        if not any(cookies.get(name) for name in ('sessionid', 'sessionid_ss', 'sid_tt')):
            raise QRUnavailable('手机确认尚未返回完整会话，请重新获取二维码。')
        return QRCredentials(tuple(sorted(cookies.items())), token)

    def exchange(self, address):
        """Follow this challenge's callback only within the fixed web origin.

        Redirects are bounded navigation, not retries. Never load the saved
        account or pass a callback URL to a browser, logger or public snapshot.
        """
        address = callback_address(address)
        seen = set()
        token = ''
        try:
            for _ in range(4):
                if self.closed:
                    raise QRUnavailable('二维码会话已取消。')
                if address in seen:
                    raise QRUnavailable('手机确认续接未完成，请重新获取二维码。')
                seen.add(address)
                request = urllib.request.Request(address, headers={
                    'Accept': '*/*', 'Referer': ORIGIN + '/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
                })
                try:
                    response = self.opener.open(request, timeout=15)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    if self.closed:
                        raise QRUnavailable('二维码会话已取消。')
                    code = response.status
                    issued_token = response.headers.get('x-tt-token')
                    if issued_token is not None:
                        token = issued_token
                    if code in (301, 302, 303, 307, 308):
                        destination = response.headers.get('Location')
                        if not isinstance(destination, str) or not destination:
                            raise QRUnavailable('手机确认续接未完成，请重新获取二维码。')
                        address = callback_address(urllib.parse.urljoin(address, destination))
                        continue
                    if code not in (200, 204):
                        raise QRUnavailable('手机确认续接未完成，请重新获取二维码。')
                break
            else:
                raise QRUnavailable('手机确认续接未完成，请重新获取二维码。')
            return self._credentials(token)
        except QRUnavailable:
            raise
        except Exception:
            raise QRUnavailable('手机确认续接失败，原账号已保留。') from None
        finally:
            if self.closed:
                self.jar.clear()


@dataclass(repr=False)
class QRChallenge:
    id: str
    text: str = field(repr=False)
    token: str = field(repr=False)
    expires_at: float


class QRStartSession:
    def __init__(self, transport=None, now=time.time):
        self.transport = transport if transport is not None else QRTransport()
        self.now = now
        self.challenge = None
        self.closed = False
        self.started = False
        self.terminal = None
        self.guard = threading.RLock()

    def start(self):
        with self.guard:
            if self.closed or self.started:
                raise QRUnavailable('请重新创建二维码会话。')
            # A lost response is not replayed into the same conversation.
            self.started = True
        value = self.transport.start(start_parameters(self.now()))
        if self.closed:
            self.transport.close()
            raise QRUnavailable('二维码会话已取消。')
        data = value.get('data')
        if value.get('message') != 'success' or not isinstance(data, dict) or data.get('error_code', 0) != 0:
            raise QRUnavailable('服务暂未提供可用二维码，请稍后重试。')
        # The web endpoint supplies an image in qrcode and the actual scan
        # payload in qrcode_index_url. Encode that payload locally for display.
        token, code = data.get('token'), data.get('qrcode_index_url')
        if not all(isinstance(v, str) and 0 < len(v) <= 8192 and not any(ord(c) < 32 for c in v) for v in (token, code)):
            raise QRUnavailable('二维码信息不完整，请稍后重试。')
        uri = urllib.parse.urlsplit(code)
        if uri.scheme != 'https' or not uri.hostname or uri.username or uri.password:
            raise QRUnavailable('二维码地址不可用，请重新获取。')
        duration = data.get('expire_time', 180)
        if type(duration) is int and duration > 1000000000:
            duration = duration - int(self.now())
        if type(duration) is not int or not 1 <= duration <= 600:
            raise QRUnavailable('二维码有效期不可用，请重新获取。')
        with self.guard:
            if self.closed:
                self.transport.close()
                raise QRUnavailable('二维码会话已取消。')
            self.challenge = QRChallenge(secrets.token_hex(16), code, token, self.now() + duration)
            return self.challenge

    def state(self):
        with self.guard:
            if self.closed:
                return self.terminal
            if self.challenge is None:
                return 'idle'
            if self.now() >= self.challenge.expires_at:
                self.challenge = None
                self.transport.close()
                self.closed = True
                self.terminal = 'expired'
                return 'expired'
            return 'waiting-for-scan'

    def cancel(self):
        with self.guard:
            self.closed = True
            self.terminal = 'cancelled'
            self.challenge = None
            self.transport.close()


@dataclass(repr=False, frozen=True)
class QRConfirmation:
    challenge_id: str
    redirect_url: str = field(repr=False)


class QRLoginSession(QRStartSession):
    """One challenge's bounded status reads, separate from account adoption.

    A confirmation is only a private handoff to a later profile verification.
    This class never authenticates, registers a device or persists an account.
    """
    def __init__(self, transport=None, now=time.time, clock=time.monotonic):
        super().__init__(transport, now)
        self.clock = clock
        self.phase = 'idle'
        self.next_poll = 0.0
        self.polling = False
        self.polls = 0
        self.confirmation = None
        self.notice = ''
        self._start_claimed = False
        self.exchanging = False
        self.exchange_attempted = False
        self.credentials = None
        self.account = None
        self.verifying = False
        self.verify_attempted = False
        self.handoff_deadline = None

    def start(self):
        with self.guard:
            # Reject duplicate calls outside the failure handler: they must not
            # cancel a valid challenge or the first in-flight creation request.
            if self.closed or self._start_claimed:
                raise QRUnavailable('请使用当前二维码，或取消后重新获取。')
            self._start_claimed = True
            self.phase = 'creating'
        try:
            challenge = super().start()
        except Exception:
            with self.guard:
                if not self.closed:
                    self._finish('error', '二维码未能创建，请重新获取。')
            raise
        with self.guard:
            if self.closed:
                self.transport.close()
                raise QRUnavailable('二维码会话已取消。')
            self.phase = 'waiting-for-scan'
            return challenge

    def _finish(self, phase, notice=''):
        self.phase = self.terminal = phase
        self.notice = notice
        self.closed = True
        self.challenge = self.confirmation = self.credentials = self.account = None
        self.transport.close()

    def state(self):
        with self.guard:
            # The QR code's scan deadline is no longer the completed login's
            # deadline. Give the verified handoff a separate, bounded lifetime.
            if not self.closed and self.handoff_deadline is not None:
                if self.clock() >= self.handoff_deadline:
                    self._finish('expired', '扫码会话已过期，原登录已保留。')
                return self.phase
            base = super().state()
            if self.closed:
                self.phase = base
                self.confirmation = None
                self.credentials = None
                self.account = None
            return self.phase

    def snapshot(self):
        with self.guard:
            phase = self.state()
            return {'phase': phase, 'authenticated': False,
                    'expiresIn': max(0, int(self.challenge.expires_at-self.now())) if self.challenge else 0,
                    'retryAfterMs': max(0, int((self.next_poll-self.clock())*1000)),
                    'pending': self.polling or self.exchanging or self.verifying, 'message': self.notice,
                    'identityVerified': self.account is not None}

    def poll(self, challenge_id):
        with self.guard:
            self.state()
            if self.closed:
                return self.snapshot()
            if self.challenge is None or challenge_id != self.challenge.id:
                raise QRUnavailable('二维码会话已更新，请使用当前二维码。')
            if self.confirmation is not None or self.polling or self.clock() < self.next_poll:
                return self.snapshot()
            if self.polls >= 300:
                self._finish('expired', '二维码已失效，请重新获取。')
                return self.snapshot()
            self.polling = True
            self.polls += 1
            self.next_poll = self.clock() + 2.0
            challenge = self.challenge
            params = start_parameters(self.now())
            params['token'] = challenge.token
        try:
            value = self.transport.poll(params)
            with self.guard:
                self._receive(value, challenge)
        except Exception:
            with self.guard:
                if self.closed:
                    self.transport.close()
                else:
                    self._finish('error', '二维码状态查询失败，请重新获取。')
        finally:
            with self.guard:
                # Snapshot and ownership release are atomic. A new poll must
                # not have its pending flag cleared by the previous caller.
                self.polling = False
                settled = self.snapshot()
        return settled

    def _receive(self, value, challenge):
        """Apply one result while holding guard; cancellation/expiry wins."""
        self.state()
        if self.closed or self.challenge is not challenge:
            self.transport.close()
            return
        if not isinstance(value, dict):
            raise QRUnavailable('二维码状态查询失败，请重新获取。')
        data = value.get('data')
        if value.get('message') != 'success' or not isinstance(data, dict) or type(data.get('error_code', 0)) is not int or data.get('error_code', 0) != 0:
            raise QRUnavailable('二维码状态查询失败，请重新获取。')
        status = data.get('status')
        if status == 'new':
            if self.phase != 'waiting-for-confirmation':
                self.phase = 'waiting-for-scan'
        elif status == 'scanned':
            self.phase = 'waiting-for-confirmation'
        elif status == 'expired':
            self._finish('expired', '二维码已失效，请重新获取。')
        elif status == 'confirmed':
            address = callback_address(data.get('redirect_url'))
            self.confirmation = QRConfirmation(challenge.id, address)
            self.phase = 'confirmation-received'
        else:
            raise QRUnavailable('二维码状态暂不可用，请重新获取。')

    def cancel(self):
        with self.guard:self._finish('cancelled')

    def exchange(self, challenge_id):
        """Obtain fresh credentials once; the caller must still verify identity.

        Nothing from this operation is written into the active account flow.
        """
        with self.guard:
            self.state()
            if self.closed or not self.confirmation or self.confirmation.challenge_id != challenge_id:
                raise QRUnavailable('请先完成当前二维码的手机确认。')
            if self.exchange_attempted:
                raise QRUnavailable('手机确认正在处理或已处理，请勿重复提交。')
            self.exchange_attempted = self.exchanging = True
            confirmation = self.confirmation
            self.phase = 'exchanging'
        try:
            credentials = self.transport.exchange(confirmation.redirect_url)
            with self.guard:
                self.state()
                if self.closed or self.confirmation is not confirmation:
                    raise QRUnavailable('二维码会话已取消或过期。')
                if not isinstance(credentials, QRCredentials):
                    raise QRUnavailable('手机确认会话不可用，请重新获取二维码。')
                self.credentials = credentials
                self.handoff_deadline = self.clock() + 300
                self.phase = 'credentials-received'
                return credentials
        except Exception:
            with self.guard:
                if not self.closed:
                    self._finish('error', '手机确认续接未完成，原账号已保留。')
            raise QRUnavailable('手机确认续接未完成，原账号已保留。') from None
        finally:
            with self.guard:
                self.exchanging = False
                if self.closed:
                    self.transport.close()

    def verify(self, challenge_id):
        """One same-origin Passport identity query. Never replaces active login."""
        with self.guard:
            self.state()
            if self.closed or not self.confirmation or self.confirmation.challenge_id != challenge_id or self.credentials is None:
                raise QRUnavailable('请先完成当前二维码的手机确认。')
            if self.verify_attempted:
                raise QRUnavailable('扫码身份已核对或正在核对，请勿重复提交。')
            self.verify_attempted = self.verifying = True
            self.phase = 'verifying-identity'
            credentials = self.credentials
        try:
            account = self.transport.verify(start_parameters(self.now()), credentials)
            with self.guard:
                self.state()
                if self.closed or self.credentials is not credentials:
                    raise QRUnavailable('扫码会话已取消或过期。')
                if not isinstance(account, QRAccount) or not isinstance(account.credentials, QRCredentials):
                    raise QRUnavailable('扫码身份核对未完成。')
                self.account = account
                self.credentials = account.credentials
                self.phase = 'identity-verified'
                return account
        except Exception:
            with self.guard:
                if not self.closed:
                    self._finish('error', '扫码身份核对未完成，原登录已保留。')
            raise QRUnavailable('扫码身份核对未完成，原登录已保留。') from None
        finally:
            with self.guard:
                self.verifying = False
                if self.closed:
                    self.transport.close()
