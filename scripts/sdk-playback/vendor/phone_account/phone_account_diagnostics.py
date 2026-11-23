"""Bounded diagnostic metadata, never requests, credentials or response bodies."""
import json
import re
import time
from pathlib import Path

ROUTES = {'/passport/mobile/send_code/v1/': 'send',
          '/passport/mobile/sms_login/': 'login',
          '/passport/upsms/verify/': 'verify'}


def response_summary(path, root):
    if path not in ROUTES or not isinstance(root, dict):
        return None
    data = root.get('data')
    data = data if isinstance(data, dict) else {}
    def numeric(value):
        return str(value) if type(value) in (int, str) and re.fullmatch(r'-?[0-9]{1,6}', str(value)) else None
    # Separate code locations; a zero outer code must not hide an inner error.
    return {'stage': ROUTES[path], 'rootCode': numeric(root.get('code')),
            'rootErrorCode': numeric(root.get('error_code')),
            'dataErrorCode': numeric(data.get('error_code')),
            'successMessage': root.get('message') == 'success',
            'challengePresent': bool(data.get('encrypt_uid') and data.get('sms_code_key'))}


class AccountDiagnostics:
    def __init__(self, directory):
        self.path = Path(directory) / 'account-request-status.json'
        self.started = int(time.time())
        self.events = []

    def record(self, path, root):
        event = response_summary(path, root)
        if event is None:
            return
        event['at'] = int(time.time())
        self.events = (self.events + [event])[-8:]
        payload = {'schema': 1, 'requestLayout': 3, 'helperStartedAt': self.started,
                   'events': self.events}
        temporary = self.path.with_suffix('.tmp')
        try:
            temporary.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf8')
            temporary.replace(self.path)
        except OSError:
            # Diagnostics must never convert an accepted login into a failure.
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
