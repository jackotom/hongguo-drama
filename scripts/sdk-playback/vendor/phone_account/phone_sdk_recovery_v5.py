"""Explicit local SDK recovery; one bounded DPAPI backup, no network or device reset."""
import base64
import hashlib
import json
from phone_sdk_session_v5 import SdkSessionError, device_binding

NAMES=('playback-sdk-v5.dpapi','playback-sdk-v5.tmp',
       'playback-sdk-v5-pending.dpapi','playback-sdk-v5-pending.tmp',
       'playback-sdk-v5-attempt.json','playback-sdk-v5-continue.json')
LIMIT=128*1024


def paths(store):
    archive=store.root/'playback-sdk-v5-recovery.dpapi'
    return archive,archive.with_suffix('.tmp')


def snapshot(store):
    files={}
    for name in NAMES:
        path=store.root/name;store.safe(path)
        if not path.exists():files[name]=None;continue
        if path.stat().st_size>16384:raise SdkSessionError('sdk-recovery-file-too-large')
        files[name]=base64.b64encode(path.read_bytes()).decode('ascii')
    return files


def ticket(binding,files):
    return hashlib.sha256(json.dumps([binding,files],sort_keys=True,separators=(',',':')).encode()).hexdigest()


def validate(value,binding):
    if (not isinstance(value,dict) or value.get('schema')!=1
            or value.get('deviceBinding')!=binding or value.get('phase') not in ('prepared','complete')):
        raise SdkSessionError('invalid-sdk-recovery-record')
    files=value.get('files')
    if not isinstance(files,dict) or set(files)!=set(NAMES):raise SdkSessionError('invalid-sdk-recovery-record')
    for raw in files.values():
        if raw is not None:
            if not isinstance(raw,str) or len(raw)>21848:raise SdkSessionError('invalid-sdk-recovery-record')
            try:data=base64.b64decode(raw,validate=True)
            except ValueError:raise SdkSessionError('invalid-sdk-recovery-record') from None
            if len(data)>16384:raise SdkSessionError('invalid-sdk-recovery-record')
    if value.get('ticket')!=ticket(binding,files):raise SdkSessionError('invalid-sdk-recovery-record')
    return value


def load(store,context):
    archive,temp=paths(store)
    for path in (archive,temp):store.safe(path)
    # A complete interrupted write supersedes the previous backup only after
    # the user resumes this transaction. No file is promoted during inspection.
    path=temp if temp.exists() else archive
    if not path.exists():return None,None
    if path.stat().st_size>LIMIT:raise SdkSessionError('invalid-sdk-recovery-record')
    try:value=json.loads(store.protect(path.read_bytes(),decrypt=True))
    except Exception:raise SdkSessionError('invalid-sdk-recovery-record') from None
    return validate(value,device_binding(context)),path


def remaining_matches(store,value):
    current=snapshot(store)
    # During a prepared transaction an archived file can already be removed;
    # changed/new files are never removed under an old confirmation ticket.
    return all(raw is None or raw==value['files'][name] for name,raw in current.items())


def pending_status(store,context):
    value,path=load(store,context)
    if value is None:return None
    archive,temp=paths(store)
    if value['phase']=='prepared' or path==temp:
        if not remaining_matches(store,value):raise SdkSessionError('sdk-recovery-state-changed')
        return {'state':'recovery-incomplete','canContinue':False,'canPrepareNewAttempt':False,
                'canResumeRecovery':True,'recoveryTicket':value['ticket']}
    return None


def guard(store,context):
    if pending_status(store,context) is not None:
        raise SdkSessionError('sdk-recovery-incomplete')


def prepare(store,context,expected_ticket,*,confirmed=False):
    """Call only for a user-confirmed local recovery, not an automatic retry."""
    if confirmed is not True or not isinstance(expected_ticket,str) or len(expected_ticket)!=64:
        raise SdkSessionError('sdk-recovery-confirmation-required')
    with store.lock,store.exclusive():
        if store.load(context) is not None:raise SdkSessionError('sdk-recovery-not-needed')
        binding=device_binding(context);archive,temp=paths(store)
        value,origin=load(store,context)
        if value is not None and origin==archive and value['ticket']==expected_ticket and value['phase']=='complete' and all(raw is None for raw in snapshot(store).values()):
            return {'state':'prepared','alreadyPrepared':True}
        pending=pending_status(store,context)
        if pending is not None:
            if pending['recoveryTicket']!=expected_ticket:raise SdkSessionError('sdk-recovery-state-changed')
            if origin==temp:
                # Same-directory atomic replacement; complete protected backup
                # is retained before touching any active initialization record.
                temp.replace(archive)
        else:
            review=store._review(context)
            if review.get('canPrepareNewAttempt') is not True:
                raise SdkSessionError('sdk-recovery-not-eligible')
            files=snapshot(store)
            if ticket(binding,files)!=expected_ticket:raise SdkSessionError('sdk-recovery-state-changed')
            value={'schema':1,'deviceBinding':binding,'phase':'prepared',
                   'ticket':expected_ticket,'files':files}
            encoded=json.dumps(value,separators=(',',':')).encode()
            if len(encoded)>LIMIT-4096:raise SdkSessionError('sdk-recovery-record-too-large')
            store._write_protected(archive,value)
        if not remaining_matches(store,value):raise SdkSessionError('sdk-recovery-state-changed')
        for name,raw in value['files'].items():
            if raw is None:continue
            target=store.root/name;store.safe(target)
            if target.exists():
                if base64.b64encode(target.read_bytes()).decode('ascii')!=raw:
                    raise SdkSessionError('sdk-recovery-state-changed')
                target.unlink()
        value=dict(value,phase='complete')
        store._write_protected(archive,value)
        return {'state':'prepared','alreadyPrepared':False}
