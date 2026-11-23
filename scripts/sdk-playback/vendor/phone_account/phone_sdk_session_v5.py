"""Own anonymous SDK sessions, protected by Windows DPAPI and device binding.

Does not load an account, rotate device identities, or refresh on playback
failure. An explicit first-use exchange is bounded to pending -> ready.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
import uuid
from contextlib import contextmanager
from phone_account_device import dpapi
from phone_sdk_bootstrap_v5 import prepare_bootstrap
from phone_sdk_exchange_v5 import exchange_response
from phone_sdk_materials_v5 import decode_app_config, read_sdk_image


class SdkSessionError(ValueError):
    pass


def failure_kind(error):
    """Local fixed categories only; never persist remote text or credentials."""
    import requests
    if isinstance(error, (TimeoutError, ConnectionError, requests.exceptions.Timeout,
                          requests.exceptions.ConnectionError)):
        # TLS validation failures are not a reason to restart initialization.
        if isinstance(error, requests.exceptions.SSLError):
            return 'tls-rejected'
        return 'transport-unconfirmed'
    if isinstance(error, SdkSessionError):
        return {
            'sdk-request-http-rejected':'service-rejected',
            'sdk-session-still-pending':'service-rejected',
            'sdk-response-empty':'response-unconfirmed',
            'sdk-response-limit':'response-unconfirmed',
        }.get(str(error), 'state-or-protocol')
    if isinstance(error, OSError):return 'local-storage'
    return 'state-or-protocol'


def device_binding(context):
    if not isinstance(context, dict) or context.get('cookies', {}).get('store-region-src') == 'uid':
        raise SdkSessionError('anonymous-sdk-device-required')
    params = context.get('params', {})
    keys = ('aid', 'device_id', 'iid', 'cdid')
    if params.get('aid') != '8662' or any(not isinstance(params.get(k), str) or not params[k] for k in keys):
        raise SdkSessionError('invalid-sdk-device')
    data = json.dumps({k: params[k] for k in keys}, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(data).hexdigest()


def validate_state(state, binding, *, expected_status=200):
    if not isinstance(state, dict) or state.get('schema') != 1 or state.get('sdkVersion') != 'v04.10.03-ml-android' or state.get('status') != expected_status:
        raise SdkSessionError('invalid-saved-sdk-session')
    if state.get('deviceBinding') != binding:
        raise SdkSessionError('sdk-session-device-mismatch')
    token = state.get('token')
    if not isinstance(token, str) or not 1 <= len(token) <= 256 or any(ord(c)<33 or ord(c)>126 for c in token):
        raise SdkSessionError('invalid-saved-sdk-session')
    if type(state.get('ladon')) is not int or not 0 <= state['ladon'] <= 0xffffffff:
        raise SdkSessionError('invalid-saved-sdk-session')
    if type(state.get('createdAt')) is not int or state['createdAt'] < 0:
        raise SdkSessionError('invalid-saved-sdk-session')
    return dict(state)


def send_prepared(request, *, client_factory=None):
    import requests
    from urllib.parse import urlsplit
    parts = urlsplit(request.url)
    if (parts.scheme, parts.netloc, parts.path) not in (
        ('https','mssdk.zijieapi.com','/sdi/get_token'),
        ('https','api5-normal-sinfonlineb.fqnovel.com','/novel/player/multi_video_model/player/v1')):
        raise SdkSessionError('invalid-sdk-request-route')
    if any(k.lower() in ('authorization','x-tt-token','x-tt-passport-csrf-token') for k in request.headers):
        raise SdkSessionError('account-auth-on-sdk-route')
    with (client_factory or requests.Session)() as client:
        client.trust_env=False; client.auth=None; client.cookies.clear(); client.headers.clear()
        wire=client.prepare_request(requests.Request('POST',request.url,headers=request.headers,data=request.body))
        if wire.url!=request.url or wire.body!=request.body or client.get_adapter(wire.url).max_retries.total!=0:
            raise SdkSessionError('sdk-request-encoding-changed')
        started=time.monotonic()
        with client.send(wire,timeout=(8,20),verify=True,allow_redirects=False,stream=True) as response:
            if response.status_code!=200: raise SdkSessionError('sdk-request-http-rejected')
            limit=131072 if parts.path=='/sdi/get_token' else 2*1024*1024
            data=bytearray()
            for chunk in response.iter_content(32768):
                if len(data)+len(chunk)>limit or time.monotonic()-started>45:
                    raise SdkSessionError('sdk-response-limit')
                data.extend(chunk)
        if not data: raise SdkSessionError('sdk-response-empty')
        return bytes(data)


class SessionStore:
    def __init__(self, directory, *, protect=dpapi, sender=send_prepared):
        self.root=Path(directory)
        if not self.root.is_absolute() or not self.root.is_dir() or self.root.is_symlink():
            raise SdkSessionError('invalid-sdk-state-directory')
        self.path=self.root/'playback-sdk-v5.dpapi'
        self.marker=self.root/'playback-sdk-v5-attempt.json'
        self.pending=self.root/'playback-sdk-v5-pending.dpapi'
        self.claim=self.root/'playback-sdk-v5-continue.json'
        self.lock_path=self.root/'playback-sdk-v5.lock'
        self.protect=protect; self.sender=sender; self.lock=threading.RLock()

    @contextmanager
    def exclusive(self):
        """Serialize preparation/review across processes; release on process exit."""
        self.safe(self.lock_path)
        stream=self.lock_path.open('a+b')
        try:
            if os.fstat(stream.fileno()).st_nlink!=1:
                raise SdkSessionError('invalid-sdk-state-path')
            if os.fstat(stream.fileno()).st_size==0:
                stream.write(b'0');stream.flush()
            stream.seek(0)
            try:
                if os.name=='nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            except OSError:
                raise SdkSessionError('sdk-state-busy') from None
            yield
        finally:
            stream.close()

    def _journal(self, context, state, requests):
        return {'schema':2,'deviceBinding':device_binding(context),
                'attemptId':uuid.uuid4().hex,'state':state,'requests':requests,'maxRequests':2}

    def review(self, context):
        """Local evidence for a recovery UI; only lock metadata may be written."""
        with self.lock, self.exclusive():
            result=self._review(context)
            if result.get('canPrepareNewAttempt') is True:
                from phone_sdk_recovery_v5 import snapshot,ticket
                result['recoveryTicket']=ticket(device_binding(context),snapshot(self))
            return result

    def _review(self, context):
        try:
            if self.load(context) is not None:
                return {'state':'ready','canContinue':False,'canPrepareNewAttempt':False}
            from phone_sdk_recovery_v5 import pending_status
            interrupted=pending_status(self,context)
            if interrupted is not None:return interrupted
            binding=device_binding(context)
            self.safe(self.claim);self.safe(self.marker)
            # Fully saved responses can be resumed by the existing playback
            # action; do not abandon them just because a journal write failed.
            for path,status in ((self.path,200),(self.pending,202)):
                temp=path.with_suffix('.tmp');self.safe(temp)
                if path.exists() or not temp.exists():continue
                if temp.stat().st_size>16384:raise SdkSessionError('invalid-interrupted-sdk-save')
                saved=json.loads(self.protect(temp.read_bytes(),decrypt=True))
                validate_state(saved,binding,expected_status=status)
                if status==202 and (type(saved.get('requestsUsed')) is not int or saved['requestsUsed']!=1):
                    raise SdkSessionError('invalid-pending-sdk-session')
                if status==200 or not self.claim.exists():
                    return {'state':'saved-response-ready','canContinue':True,'canPrepareNewAttempt':False}
            pending=self._load_pending(context)
            if pending is not None and not self.claim.exists():
                return {'state':'continuation-ready','canContinue':True,'canPrepareNewAttempt':False}
            if not self.marker.exists():
                return {'state':'review-required' if self.claim.exists() else 'not-started',
                        'canContinue':False,'canPrepareNewAttempt':False}
            if self.marker.stat().st_size>4096:raise SdkSessionError('invalid-sdk-journal')
            record=json.loads(self.marker.read_text(encoding='utf8'))
            valid=(isinstance(record,dict) and record.get('schema')==2
                   and record.get('deviceBinding')==binding and record.get('maxRequests')==2
                       and isinstance(record.get('attemptId'),str) and re.fullmatch('[0-9a-f]{32}',record['attemptId'])
                   and type(record.get('requests')) is int and 0<=record['requests']<=2)
            if not valid:return {'state':'review-required','canContinue':False,'canPrepareNewAttempt':False}
            if (record['requests']==1 and self.claim.exists()) or (record['requests']==2 and not self.claim.exists()):
                return {'state':'review-required','canContinue':False,'canPrepareNewAttempt':False}
            if self.claim.exists():
                if self.claim.stat().st_size>4096:raise SdkSessionError('invalid-sdk-claim')
                claim=json.loads(self.claim.read_text(encoding='utf8'))
                if claim!={'state':'reserved','requests':2,'maxRequests':2}:
                    raise SdkSessionError('invalid-sdk-claim')
            kind=record.get('failureKind') if record.get('state')=='stopped' else None
            if kind=='service-rejected':state='service-rejected'
            elif kind=='transport-unconfirmed':state='transport-unconfirmed'
            elif kind=='tls-rejected':state='tls-rejected'
            elif kind=='local-storage':state='local-storage'
            else:state='review-required'
            return {'state':state,'canContinue':False,
                    'canPrepareNewAttempt':state=='transport-unconfirmed' and record['requests'] in (1,2)}
        except (OSError,ValueError,TypeError,KeyError):
            return {'state':'review-required','canContinue':False,'canPrepareNewAttempt':False}

    def safe(self, path):
        if path.parent!=self.root or path.is_symlink() or path.exists() and (not path.is_file() or path.stat().st_nlink!=1):
            raise SdkSessionError('invalid-sdk-state-path')

    def load(self, context):
        binding=device_binding(context)
        self.safe(self.path)
        if not self.path.exists(): return None
        if self.path.stat().st_size>16384: raise SdkSessionError('invalid-saved-sdk-session')
        try:
            state=json.loads(self.protect(self.path.read_bytes(),decrypt=True))
        except Exception: raise SdkSessionError('sdk-session-unavailable') from None
        return validate_state(state,binding)

    def save(self, context, state):
        state=validate_state(state,device_binding(context))
        self._write_protected(self.path,state)

    def _write_protected(self, path, state):
        temp=path.with_suffix('.tmp')
        self.safe(path); self.safe(temp)
        if temp.exists(): raise SdkSessionError('sdk-session-save-incomplete')
        encrypted=self.protect(json.dumps(state,separators=(',',':')).encode())
        try:
            with temp.open('xb') as file: file.write(encrypted)
            temp.replace(path)
        finally:
            if temp.exists(): temp.unlink()

    def _load_pending(self, context):
        self.safe(self.pending)
        if not self.pending.exists(): return None
        if self.pending.stat().st_size>16384: raise SdkSessionError('invalid-pending-sdk-session')
        try:
            state=json.loads(self.protect(self.pending.read_bytes(),decrypt=True))
        except Exception: raise SdkSessionError('pending-sdk-session-unavailable') from None
        state=validate_state(state,device_binding(context),expected_status=202)
        if type(state.get('requestsUsed')) is not int or state['requestsUsed']!=1:
            raise SdkSessionError('invalid-pending-sdk-session')
        return state

    def _recover_completed_write(self, context, path, status):
        """Recover a complete DPAPI file left by process exit before rename.

        Windows rename does not replace an existing destination. A concurrent
        completed save wins; an incomplete/foreign temporary file is retained
        for diagnosis and must never authorize another exchange.
        """
        temp=path.with_suffix('.tmp')
        self.safe(path); self.safe(temp)
        if path.exists() or not temp.exists():return
        if temp.stat().st_size>16384:raise SdkSessionError('invalid-interrupted-sdk-save')
        try:
            state=json.loads(self.protect(temp.read_bytes(),decrypt=True))
        except Exception:raise SdkSessionError('interrupted-sdk-save-unavailable') from None
        validate_state(state,device_binding(context),expected_status=status)
        if status==202 and (type(state.get('requestsUsed')) is not int or state['requestsUsed']!=1):
            raise SdkSessionError('invalid-pending-sdk-session')
        # DPAPI persistence is Windows-only. Do not emulate Windows no-replace
        # semantics with POSIX rename, which could overwrite a concurrent save.
        if os.name!='nt':raise SdkSessionError('sdk-save-recovery-requires-windows')
        try:temp.rename(path)
        except (FileExistsError,FileNotFoundError):
            if not path.exists():raise SdkSessionError('interrupted-sdk-save-unavailable') from None
        self.safe(path)

    def _state(self, context, result, prepared):
        return {'schema':1,'sdkVersion':'v04.10.03-ml-android','status':result.status,
                'deviceBinding':device_binding(context),'token':result.token,
                'ladon':prepared.next_ladon,'createdAt':int(time.time())}

    def can_continue(self, context):
        """Read-only proof that the remaining exchange has not been reserved."""
        with self.lock:
            if self.load(context) is not None:return False
            self.safe(self.claim)
            return not self.claim.exists() and self._load_pending(context) is not None

    def _continue(self, context, pending, materials, image, core):
        # A durable 202 response proves that only the second exchange remains.
        # Reserve it exclusively before transport. A timeout or crash after
        # this point stays unresolved; it must never become an automatic retry.
        self.safe(self.claim)
        if self.claim.exists(): raise SdkSessionError('previous-sdk-exchange-needs-review')
        prepared=prepare_bootstrap(context,int(time.time()*1000),materials=materials,image=image,core=core,
                                   token=pending['token'],previous_ladon=pending['ladon'])
        with self.claim.open('x',encoding='utf8') as file:
            json.dump({'state':'reserved','requests':2,'maxRequests':2},file)
        record=self._journal(context,'request-in-flight',2)
        try:
            self.marker.write_text(json.dumps(record),encoding='utf8')
            result=exchange_response(self.sender(prepared),common=materials.exchange_key,inner=image.exchange_inner_key)
            if result.status!=200: raise SdkSessionError('sdk-session-still-pending')
            state=self._state(context,result,prepared); self.save(context,state)
            record['state']='ready'; self.marker.write_text(json.dumps(record),encoding='utf8')
            self.safe(self.pending); self.pending.unlink()
            return state
        except Exception as error:
            record.update(state='stopped',errorType=type(error).__name__,failureKind=failure_kind(error))
            self.marker.write_text(json.dumps(record),encoding='utf8')
            raise

    def ensure(self, context, assets, *, core, allow_exchange=False):
        with self.lock, self.exclusive():
            saved=self.load(context)
            if saved is not None: return saved
            from phone_sdk_recovery_v5 import guard
            guard(self,context)
            self._recover_completed_write(context,self.path,200)
            saved=self.load(context)
            if saved is not None:return saved
            self.safe(self.marker)
            self.safe(self.claim)
            self._recover_completed_write(context,self.pending,202)
            pending=self._load_pending(context)
            if pending is not None:
                if not allow_exchange: raise SdkSessionError('sdk-continuation-not-enabled')
                return self._continue(context,pending,decode_app_config(assets.configuration),read_sdk_image(assets.image),core)
            if self.marker.exists() or self.claim.exists(): raise SdkSessionError('previous-sdk-exchange-needs-review')
            if not allow_exchange: raise SdkSessionError('sdk-session-not-initialized')
            materials=decode_app_config(assets.configuration)
            image=read_sdk_image(assets.image)
            prepared=prepare_bootstrap(context,int(time.time()*1000),materials=materials,image=image,core=core)
            record=self._journal(context,'reserved',0)
            with self.marker.open('x',encoding='utf8') as file: json.dump(record,file)
            def record_state(): self.marker.write_text(json.dumps(record),encoding='utf8')
            try:
                record.update(state='request-in-flight',requests=1); record_state()
                result=exchange_response(self.sender(prepared),common=materials.exchange_key,inner=image.exchange_inner_key)
                state=self._state(context,result,prepared)
                if result.status==200:
                    self.save(context,state)
                    record['state']='ready'; record_state(); return state
                if result.status!=202: raise SdkSessionError('sdk-session-still-pending')
                state['requestsUsed']=1
                validate_state(state,device_binding(context),expected_status=202)
                self._write_protected(self.pending,state)
                record['state']='continuation-ready'; record_state()
            except Exception as error:
                record.update(state='stopped',errorType=type(error).__name__,failureKind=failure_kind(error)); record_state()
                raise
            return self._continue(context,state,materials,image,core)
