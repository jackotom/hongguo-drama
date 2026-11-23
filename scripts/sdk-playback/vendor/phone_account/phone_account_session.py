"""User-scoped encrypted login persistence; never stores OTP or MFA challenges."""
import hashlib
import json
import os
import re
import time
import math
from pathlib import Path

TTL = 30 * 24 * 60 * 60
LIMIT = 1024 * 1024
LIBRARY_LIMIT = 4 * 1024 * 1024


def protect(data, decrypt=False):
    from phone_account_device import dpapi
    return dpapi(data, decrypt=decrypt)


class SessionStore:
    def __init__(self, device_path, crypt=protect, clock=time.time):
        self.path = Path(device_path).with_name('account-session.dpapi')
        self.crypt, self.clock = crypt, clock
        self.remember, self.saved, self.created = True, False, None
        self.notice = ''

    def binding(self, transport):
        params = (transport.context or {}).get('params', {})
        identity = [params.get(key) for key in ('aid', 'device_id', 'iid')]
        if identity[0] != '8662' or any(not isinstance(x, str) or not x for x in identity):
            raise ValueError('device unavailable')
        return hashlib.sha256(json.dumps(identity).encode()).hexdigest()

    def write(self, value, *, limit=LIMIT):
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
        if len(raw) > limit: raise ValueError('session too large')
        encrypted = self.crypt(raw)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        try:
            with temporary.open('wb') as file:
                file.write(encrypted); file.flush(); os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def load(self, flow, host):
        if not self.path.exists(): return
        try:
            if self.path.stat().st_size > LIMIT + 4096: raise ValueError()
            value = json.loads(self.crypt(self.path.read_bytes(), decrypt=True))
            if value.get('version') != 1 or type(value.get('remember')) is not bool: raise ValueError()
            self.remember = value['remember']
            if not self.remember: return
            created = value['created']
            if type(created) not in (int, float) or not 0 <= self.clock() - created < TTL:
                self.clear(); self.notice = '本机保存的登录已过期，请重新登录。'; return
            if value['device'] != self.binding(flow.transport): raise ValueError()
            uid, name, token, cookies = (value[k] for k in ('uid','name','token','cookies'))
            if not isinstance(uid,str) or not re.fullmatch(r'[0-9]{5,30}',uid) or not int(uid): raise ValueError()
            if not isinstance(name,str) or len(name)>100 or not isinstance(token,str) or len(token)>8192: raise ValueError()
            if not isinstance(cookies,dict) or len(cookies)>80: raise ValueError()
            if any(not isinstance(k,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',k) or not isinstance(v,str) or len(v)>8192 or '\r' in v or '\n' in v for k,v in cookies.items()): raise ValueError()
            if not token and not any(cookies.get(k) for k in ('sessionid','sessionid_ss','sid_tt')): raise ValueError()
            flow.transport.client.cookies.clear()
            for key,val in cookies.items(): flow.transport.client.cookies.set(key,val,domain=host,path='/')
            flow.transport.token = token
            flow.uid, flow.name, flow.phase = uid, name, 'restored'
            self.created, self.saved = created, True
            self.notice = '已恢复本机登录；读取云片单时会确认会话是否仍有效。'
        except Exception:
            flow.cancel()
            self.saved = False
            self.notice = '无法恢复本机保存的登录，请重新登录。'

    def save(self, flow):
        if not self.remember or not flow.uid: return
        created = self.created if self.created is not None else self.clock()
        cookies = {c.name:c.value for c in flow.transport.client.cookies}
        self.write({'version':1,'remember':True,'device':self.binding(flow.transport),'created':created,
                    'uid':flow.uid,'name':flow.name,'token':flow.transport.token,'cookies':cookies})
        self.saved, self.created, self.notice = True, created, ''

    def preference(self, enabled, flow):
        if type(enabled) is not bool: raise ValueError()
        previous = self.remember
        self.remember = enabled
        try:
            if enabled and flow.uid: self.save(flow)
            else:
                self.write({'version':1,'remember':enabled}) if not enabled else self.clear()
                self.saved, self.created, self.notice = False, None, ''
        except Exception:
            self.remember = previous
            raise

    def clear(self):
        # If removal fails, replace credentials atomically with an empty preference.
        if not self.remember: self.write({'version':1,'remember':False})
        else:
            try: self.path.unlink(missing_ok=True)
            except OSError: self.write({'version':1,'remember':False})
        self.saved, self.created = False, None

    def expire(self, flow):
        if self.saved and self.created is not None and not 0 <= self.clock() - self.created < TTL:
            try: self.clear()
            finally:
                flow.cancel()
                self.notice = '本机保存的登录已过期，请重新登录。'


class LibraryCache:
    """One bounded DPAPI snapshot, readable only by the same restored account."""
    def __init__(self, device_path, crypt=protect, clock=time.time):
        self.path = Path(device_path).with_name('account-library.dpapi')
        self.crypt, self.clock = crypt, clock

    def identity(self, flow, host):
        if not isinstance(flow.uid, str) or not re.fullmatch(r'[1-9][0-9]{4,29}', flow.uid):
            raise ValueError('account unavailable')
        device = SessionStore(self.path, crypt=self.crypt).binding(flow.transport)
        return hashlib.sha256(json.dumps([device, flow.uid, host]).encode()).hexdigest()

    def validate(self, value):
        required={'favorites','history','syncedAt','complete'}
        if not isinstance(value, dict) or not required <= set(value) <= required|{'favoritesRefresh'}:
            raise ValueError('invalid snapshot')
        refresh=value.get('favoritesRefresh')
        if refresh is not None:
            if not isinstance(refresh,dict) or set(refresh)!={'syncedAt','complete'} or type(refresh['syncedAt']) is not int or not 0<=self.clock()-refresh['syncedAt']<TTL or type(refresh['complete']) is not bool:
                raise ValueError('invalid favorites refresh')
        stamp = value['syncedAt']
        favorites_only=refresh is not None and stamp==0 and value['history']==[]
        if type(stamp) is not int or (not favorites_only and not 0 <= self.clock()-stamp < TTL) or type(value['complete']) is not bool:
            raise ValueError('expired snapshot')
        for name in ('favorites','history'):
            rows=value[name]
            if not isinstance(rows,list) or len(rows)>(5000 if name=='history' else 2000): raise ValueError('oversized list')
            seen=set()
            for row in rows:
                if not isinstance(row,dict) or not {'seriesId','title','lastEpisode','positionSeconds','updatedAt'} <= set(row) <= {'seriesId','title','cover','lastEpisode','positionSeconds','updatedAt','episodeCount'}:
                    raise ValueError('invalid item')
                count=row.get('episodeCount')
                if count is not None and (type(count) is not int or not 0<count<100000): raise ValueError('invalid episode count')
                cover=row.get('cover', '')
                if not isinstance(cover,str) or len(cover.encode('utf-8'))>8192: raise ValueError('invalid cover')
                identity=row['seriesId']
                if not isinstance(identity,str) or not re.fullmatch(r'[0-9]{5,30}',identity) or not int(identity) or identity in seen:
                    raise ValueError('invalid identity')
                seen.add(identity)
                if not isinstance(row['title'],str) or len(row['title'])>200: raise ValueError('invalid title')
                episode,position,updated=(row[k] for k in ('lastEpisode','positionSeconds','updatedAt'))
                if episode is not None and (type(episode) is not int or not 0<=episode<100000): raise ValueError('invalid episode')
                if position is not None and (type(position) not in (int,float) or not math.isfinite(position) or not 0<=position<86400): raise ValueError('invalid position')
                if updated is not None and (type(updated) is not int or not 0<=updated<=4102444800): raise ValueError('invalid update time')
        return value

    def load(self, flow, host, enabled):
        if not enabled or not flow.uid: return None
        try:
            if self.path.is_symlink() or self.path.stat().st_size>LIBRARY_LIMIT+4096: return None
            root=json.loads(self.crypt(self.path.read_bytes(),decrypt=True))
            if root.get('version') not in (1,2,3) or root.get('account')!=self.identity(flow,host): return None
            library=self.validate(root['library'])
            # v1 contains wire cursors, v2 added one without handling the end
            # cursor. Only the in-memory history copy changes. A cursor at total
            # refers to the last video, not a nonexistent following episode.
            for row in library['history']:
                episode=row['lastEpisode'];count=row.get('episodeCount')
                if root['version']==1:
                    episode=episode+1 if type(episode) is int and episode<99999 else None
                if type(episode) is int and type(count) is int and episode>count:
                    episode=count if root['version'] in (1,2) and episode==count+1 else None
                row['lastEpisode']=episode
                if episode is None:row['positionSeconds']=None
            return library
        except Exception: return None

    def save(self, flow, host, library):
        value={'version':3,'account':self.identity(flow,host),'library':self.validate(library)}
        writer=SessionStore(self.path,crypt=self.crypt,clock=self.clock)
        writer.path=self.path
        if self.path.is_symlink() or self.path.with_suffix('.tmp').is_symlink(): raise ValueError('invalid cache path')
        writer.write(value, limit=LIBRARY_LIMIT)

    def clear(self):
        # A failed unlink must not leave readable account content behind.
        try: self.path.unlink(missing_ok=True)
        except OSError:
            if self.path.with_suffix('.tmp').is_symlink(): raise ValueError('invalid cache path')
            writer=SessionStore(self.path,crypt=self.crypt,clock=self.clock)
            writer.path=self.path
            writer.write({'version':1,'cleared':True})
