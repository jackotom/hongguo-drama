"""Private account-worker QR actions; credentials never enter the IPC result."""
from phone_account_flow import AccountFlow, AccountError
from phone_account_qr import QRLoginSession, QRAccount, QRUnavailable, LOGIN_COOKIE_NAMES
from phone_account_transport import HOST


class QRLoginController:
    def __init__(self, session_factory=QRLoginSession):
        self.factory = session_factory
        self.session = None
        # Keep only the opaque generation ID after expiry clears the challenge
        # and its private token. The UI must still be able to close that
        # generation before explicitly requesting a replacement.
        self.session_id = None

    def cancel(self):
        if self.session:
            self.session.cancel()
        return {'phase': 'cancelled', 'authenticated': False, 'identityVerified': False, 'pending': False}

    def current(self, identity):
        session = self.session
        if not session or not self.session_id or identity != self.session_id:
            raise AccountError('二维码已更新，请使用当前二维码。')
        return session

    def handle(self, host, request):
        action = request.get('action')
        try:
            if action == 'qr_start':
                if host.flow.uid:
                    raise AccountError('当前账号已登录；扫码不会替换已有账号。')
                if self.session and self.session.state() not in ('cancelled', 'expired', 'error'):
                    raise AccountError('请使用当前二维码，或取消后重新获取。')
                if self.session:
                    self.session.cancel()
                self.session_id = None
                self.session = self.factory()
                challenge = self.session.start()
                self.session_id = challenge.id
                return {**self.session.snapshot(), 'sessionId': challenge.id, 'qrText': challenge.text}
            session = self.current(request.get('sessionId'))
            if action == 'qr_cancel':
                return self.cancel()
            if action == 'qr_status':
                return session.snapshot()
            if action == 'qr_poll':
                session.poll(request['sessionId'])
                if session.phase == 'confirmation-received' and not session.exchange_attempted:
                    session.exchange(request['sessionId'])
                if session.phase == 'credentials-received' and not session.verify_attempted:
                    session.verify(request['sessionId'])
                # This display name comes only from Passport, not from the QR
                # polling payload. UID/cookies/token never cross the pipe.
                return {**session.snapshot(), 'displayName': session.account.name if session.account else ''}
            if action == 'qr_commit':
                session.state()
                if session.closed or not isinstance(session.account, QRAccount):
                    raise AccountError('扫码账号尚未核验，原登录已保留。')
                adopt_verified_account(host, session.account)
                session.cancel()
                return host.status()
            raise AccountError('不支持的扫码操作。')
        except QRUnavailable as error:
            raise AccountError(str(error)) from None


def adopt_verified_account(host, account):
    """Prepare a separate flow and persist before swapping a logged-out host.

    No network request is made here. The existing account host owns any later
    user-requested library access and its independent access checks.
    """
    if host.flow.uid or not isinstance(account, QRAccount):
        raise AccountError('当前登录已保留，未替换账号。')
    candidate = None
    try:
        candidate = AccountFlow(host.transport_factory(host.device_path))
        if candidate.transport.context is None:
            # Only the user's final login action may initialize the account
            # device. The shared initializer owns its durable no-replay marker.
            candidate.transport.client.close()
            host.initializer(host.device_path)
            candidate = AccountFlow(host.transport_factory(host.device_path))
        candidate.transport.ready()
        for item in list(candidate.transport.client.cookies):
            if item.name in LOGIN_COOKIE_NAMES:
                candidate.transport.client.cookies.clear(item.domain, item.path, item.name)
        for name, value in account.credentials.cookies:
            if name not in LOGIN_COOKIE_NAMES:
                raise ValueError('unexpected cookie')
            candidate.transport.client.cookies.set(name, value, domain=HOST, path='/')
        candidate.transport.token = account.credentials.token
        if not candidate.transport.authenticated_cookies():
            raise ValueError('missing session')
        candidate.uid, candidate.name, candidate.phase = account.uid, account.name, 'authenticated'
        store = host.store_factory(host.device_path)
        store.remember = host.store.remember
        # SessionStore saves atomically; failure keeps the original file and
        # active flow unchanged. A new login starts a new saved-session lifetime.
        if store.remember:
            store.save(candidate)
    except Exception:
        if candidate is not None:
            candidate.transport.client.close()
        raise AccountError('扫码会话尚未接入，原登录和本地记录已保留。') from None
    previous = host.flow
    host.flow, host.store = candidate, store
    host.clear_progress_consent()
    # Closing the old client must not undo an already committed session.
    try:
        previous.transport.client.close()
    except Exception:
        pass
