"""Account-bound picture receipts; no image bytes or login material on disk."""
import copy
import hashlib
import json
import os
import re
import stat
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from phone_account_flow import AccountError
from phone_account_session import protect
import phone_comment_picture as pictures

HEX = re.compile(r'[a-f0-9]{64}')
IDENTIFIER = re.compile(r'[a-f0-9]{32}')
MAX_ROWS = 128
MAX_AGE = 24 * 60 * 60


def context_id(flow):
    if not flow.uid or not flow.transport.authenticated_cookies(): raise AccountError('请先登录红果账号')
    params = (flow.transport.context or {}).get('params', {})
    if not params.get('device_id') or not params.get('iid'): raise AccountError('账号设备尚未就绪，图片尚未上传')
    return hashlib.sha256(json.dumps([str(flow.uid),params['device_id'],params['iid']],separators=(',',':')).encode()).hexdigest()


def valid_image(image):
    return (isinstance(image,dict) and set(image)=={'web_uri','width','height','image_type','format'}
            and bool(pictures.safe_picture_url(image.get('web_uri')))
            and type(image.get('width')) is int and 1<=image['width']<=4096
            and type(image.get('height')) is int and 1<=image['height']<=4096
            and image['width']*image['height']<=pictures.MAX_PIXELS
            and type(image.get('image_type')) is int and image['image_type']==1 and image.get('format') in ('png','jpeg'))


class PictureJournal:
    def __init__(self,device_path,crypt=protect):
        self.path=Path(device_path).with_name('account-comment-pictures.dpapi')
        self.lock_path=self.path.with_suffix('.lock');self.crypt=crypt

    @staticmethod
    def regular(path):
        if path.is_symlink(): raise ValueError('linked receipt')
        if path.exists():
            info=path.stat()
            if info.st_nlink!=1 or not stat.S_ISREG(info.st_mode): raise ValueError('nonregular receipt')

    @contextmanager
    def exclusive(self):
        try:
            self.regular(self.lock_path)
            stream=self.lock_path.open('a+b')
            try:
                info=os.fstat(stream.fileno())
                if info.st_nlink!=1 or not stat.S_ISREG(info.st_mode): raise ValueError()
                if info.st_size==0: stream.write(b'0');stream.flush()
                stream.seek(0)
                if os.name=='nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            except Exception:
                stream.close();raise
        except Exception:
            raise AccountError('另一个图片操作尚未结束，未发送新请求') from None
        try: yield
        finally: stream.close()  # Closing also releases the OS lock after exceptions.

    def read(self):
        try:
            self.regular(self.path)
            if not self.path.exists(): return {}
            if self.path.stat().st_size>1024*1024: raise ValueError()
            root=json.loads(self.crypt(self.path.read_bytes(),decrypt=True))
            if root.get('version')!=1 or not isinstance(root.get('rows'),dict) or len(root['rows'])>MAX_ROWS: raise ValueError()
            ids=set()
            for key,row in root['rows'].items():
                if not HEX.fullmatch(key) or not isinstance(row,dict): raise ValueError()
                if set(row)-{'contextId','requestId','pictureId','created','state','image'}: raise ValueError()
                if not HEX.fullmatch(row.get('contextId','')) or not IDENTIFIER.fullmatch(row.get('pictureId','')): raise ValueError()
                if row['pictureId'] in ids: raise ValueError()
                ids.add(row['pictureId'])
                if not re.fullmatch(r'[A-Za-z0-9-]{16,64}',row.get('requestId','')) or type(row.get('created')) is not int or row['created']<0: raise ValueError()
                if row.get('state') not in ('accepted','rejected','unknown'): raise ValueError()
                if row['state']=='accepted':
                    if not valid_image(row.get('image')): raise ValueError()
                elif 'image' in row: raise ValueError()
            return root['rows']
        except Exception: raise AccountError('图片上传记录无法读取，未上传或发送新内容') from None

    def write(self,rows):
        temporary=self.path.with_name(self.path.name+'.'+uuid.uuid4().hex+'.tmp')
        try:
            self.regular(self.path)
            raw=json.dumps({'version':1,'rows':rows},separators=(',',':')).encode()
            if len(rows)>MAX_ROWS or len(raw)>1000000: raise ValueError()
            with temporary.open('xb') as output:
                output.write(self.crypt(raw));output.flush();os.fsync(output.fileno())
            os.replace(temporary,self.path)
        except Exception: raise AccountError('图片上传记录未保存，不会自动重试') from None
        finally: temporary.unlink(missing_ok=True)


def public(row,context):
    state=row['state']
    value={'state':state,'contextId':context,'message':pictures.UNKNOWN['message'] if state=='unknown' else '图片已上传，评论尚未发送。' if state=='accepted' else '图片上传被拒绝，评论未发送。'}
    if state=='accepted': value.update(pictureId=row['pictureId'],width=row['image']['width'],height=row['image']['height'])
    return value


def handle(flow,request,device_path,*,journal_factory=PictureJournal,sender=pictures.upload,now=None):
    if not isinstance(request,dict): raise AccountError('图片请求无效')
    context=context_id(flow)
    if request.get('action')=='picture_status':
        if set(request)!={'action'}: raise AccountError('图片状态请求不能包含上传内容')
        return {'contextId':context,'enabled':pictures.WRITES_ENABLED,'maxBytes':pictures.MAX_BYTES,'maxPictures':9}
    if request.get('action')!='picture_upload' or set(request)!={'action','contextId','requestId','dataUrl'}: raise AccountError('图片上传参数无效，尚未上传')
    if request['contextId']!=context: raise AccountError('登录账号已变化，请重新确认图片，尚未上传')
    if not isinstance(request['requestId'],str) or not re.fullmatch(r'[A-Za-z0-9-]{16,64}',request['requestId']): raise AccountError('图片操作标识无效，尚未上传')
    if not pictures.WRITES_ENABLED: raise AccountError('图片上传尚未接通，尚未上传')
    try: picture=pictures.prepare(request['dataUrl'])
    except AccountError: raise AccountError('图片格式或内容不符合要求，尚未上传') from None
    stamp=int(time.time()) if now is None else now
    key=hashlib.sha256((context+'\0'+picture.digest).encode()).hexdigest()
    journal=journal_factory(device_path)
    with journal.exclusive():
        rows=journal.read();previous=rows.get(key)
        if any(k!=key and row['contextId']==context and row['requestId']==request['requestId'] for k,row in rows.items()): raise AccountError('图片操作标识已用于其他图片，尚未上传')
        if previous:
            if previous['state']=='unknown': return public(previous,context)
            if previous['state']=='accepted' and 0<=stamp-previous['created']<MAX_AGE: return public(previous,context)
            if previous['requestId']==request['requestId']:
                if previous['state']=='accepted': raise AccountError('图片上传回执已过期，请重新选择图片，未自动上传')
                return public(previous,context)
        if key not in rows and len(rows)>=MAX_ROWS: raise AccountError('图片操作记录已满，尚未上传')
        row={'contextId':context,'requestId':request['requestId'],'pictureId':uuid.uuid4().hex,'created':stamp,'state':'unknown'}
        started=False
        def before_send():
            nonlocal started
            rows[key]=dict(row);journal.write(rows);started=True
        try: result=sender(flow,picture,before_send)
        except Exception:
            if not started: raise AccountError('图片准备未完成，尚未上传') from None
            return public(row,context)
        if not started: raise AccountError('图片上传未确认，评论未发送')
        if isinstance(result,dict) and result.get('state')=='accepted' and valid_image(result.get('image')):
            image=result['image']
            if (image['width'],image['height'],image['format'])==(picture.width,picture.height,picture.format): row.update(state='accepted',image=copy.deepcopy(image))
        elif isinstance(result,dict) and result.get('state')=='rejected': row['state']='rejected'
        rows[key]=row
        try: journal.write(rows)
        except AccountError: return public({**row,'state':'unknown'},context)
        return public(row,context)


def resolve(flow,identifiers,context,device_path,*,journal_factory=PictureJournal,now=None):
    if not pictures.WRITES_ENABLED: raise AccountError('图片上传尚未接通，评论未发送')
    if context!=context_id(flow): raise AccountError('登录账号已变化，图片评论尚未发送')
    if not isinstance(identifiers,list) or not 1<=len(identifiers)<=9 or any(not isinstance(x,str) or not IDENTIFIER.fullmatch(x) for x in identifiers) or len(set(identifiers))!=len(identifiers): raise AccountError('图片引用无效，评论尚未发送')
    stamp=int(time.time()) if now is None else now;journal=journal_factory(device_path)
    with journal.exclusive():
        rows={row['pictureId']:row for row in journal.read().values() if row['contextId']==context}
        result=[]
        for identifier in identifiers:
            row=rows.get(identifier)
            if not row or row['state']!='accepted' or not 0<=stamp-row['created']<MAX_AGE: raise AccountError('图片未上传完成或回执已过期，评论尚未发送')
            result.append(copy.deepcopy(row['image']))
        return result
