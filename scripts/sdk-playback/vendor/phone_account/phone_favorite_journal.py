"""Bounded encrypted receipts, owned by the serialized private account host."""
import hashlib
import json
import os
import re
import time
from pathlib import Path
from phone_account_favorites import FavoriteError
from phone_account_session import protect

LIMIT = 1024 * 1024
TERMINAL = {'verified', 'rejected'}


def account_binding(flow):
    params = (flow.transport.context or {}).get('params', {})
    values = [params.get(k) for k in ('aid', 'device_id', 'iid')] + [flow.uid]
    if values[0] != '8662' or any(not isinstance(v, str) or not v for v in values):
        raise FavoriteError('账号设备未就绪，未更改手机收藏')
    return hashlib.sha256(json.dumps(values, separators=(',', ':')).encode()).hexdigest()


class FavoriteJournal:
    def __init__(self, device_path, crypt=protect, clock=time.time):
        self.path = Path(device_path).with_name('account-favorite-attempts.dpapi')
        self.crypt, self.clock = crypt, clock

    def read(self):
        try:
            if not self.path.exists(): return []
            if self.path.is_symlink() or self.path.stat().st_size > LIMIT + 4096: raise ValueError()
            root = json.loads(self.crypt(self.path.read_bytes(), decrypt=True))
            rows = root['attempts']
            if root['version'] != 1 or not isinstance(rows, list) or len(rows) > 512: raise ValueError()
            seen = set()
            for row in rows:
                if not isinstance(row, dict) or not re.fullmatch(r'[a-f0-9]{64}', row.get('account', '')): raise ValueError()
                if not re.fullmatch(r'[a-zA-Z0-9-]{16,64}', row.get('requestId', '')): raise ValueError()
                if not re.fullmatch(r'[1-9][0-9]{7,23}', row.get('seriesId', '')): raise ValueError()
                if type(row.get('favorite')) is not bool or row.get('state') not in TERMINAL | {'unknown','acknowledged'}: raise ValueError()
                if type(row.get('at')) not in (int,float) or not 0 <= row['at'] <= 4102444800: raise ValueError()
                identity = (row['account'],row['requestId'])
                if identity in seen: raise ValueError()
                seen.add(identity)
            return rows
        except Exception:
            raise FavoriteError('无法读取待确认收藏记录，未发送新的操作') from None

    def write(self, rows):
        if len(rows) > 512: raise FavoriteError('待确认收藏记录过多，请先核对已有操作')
        raw = json.dumps({'version':1,'attempts':rows}, separators=(',', ':')).encode()
        if len(raw) > LIMIT: raise FavoriteError('收藏记录过大，未发送新的操作')
        temporary = self.path.with_suffix('.tmp')
        try:
            if self.path.is_symlink() or temporary.is_symlink(): raise ValueError()
            encrypted = self.crypt(raw)
            self.path.parent.mkdir(parents=True,exist_ok=True)
            with temporary.open('wb') as file:
                file.write(encrypted);file.flush();os.fsync(file.fileno())
            os.replace(temporary,self.path)
        except Exception:
            raise FavoriteError('无法保存收藏操作记录，请先核对手机片单') from None
        finally:
            try: temporary.unlink(missing_ok=True)
            except OSError: pass

    def begin(self, account, request):
        rows = self.read()
        for row in rows:
            if row['account'] != account: continue
            if row['requestId'] == request['requestId']:
                if (row['seriesId'],row['favorite']) != (request['seriesId'],request['favorite']):
                    raise FavoriteError('操作标识已使用，请重新选择收藏操作')
                return row, False
        for row in rows:
            if row['account'] == account and row['seriesId'] == request['seriesId'] and row['state'] not in TERMINAL:
                return row, False
        pending = [row for row in rows if row['state'] not in TERMINAL]
        terminal = sorted((row for row in rows if row['state'] in TERMINAL),key=lambda row:row['at'])[-256:]
        row = {'account':account,'requestId':request['requestId'],'seriesId':request['seriesId'],
               'favorite':request['favorite'],'state':'unknown','at':self.clock()}
        self.write(pending + terminal + [row])
        return row, True

    def finish(self, account, request_id, state):
        if state not in TERMINAL | {'unknown','acknowledged'}: raise FavoriteError('收藏结果无效')
        rows = self.read()
        for row in rows:
            if row['account'] == account and row['requestId'] == request_id:
                row['state'] = state;self.write(rows);return row
        raise FavoriteError('没有找到此账号的收藏操作记录')

    def find(self, account, request_id):
        return next((row for row in self.read() if row['account']==account and row['requestId']==request_id),None)

    def pending(self, account):
        return [row for row in self.read() if row['account']==account and row['state'] not in TERMINAL]
