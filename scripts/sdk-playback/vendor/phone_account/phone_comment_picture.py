"""Independent picture preparation and one-shot upload transport.

Only public request/response field shapes were observed from synthetic fixtures.
Manual uploads are authorized; each upload remains separate from publication.
"""
import base64
import hashlib
import io
import json
import re
import secrets
import time
import warnings
from dataclasses import dataclass
from urllib.parse import urlencode, urlsplit

import requests
from PIL import Image, ImageOps
from phone_account_flow import AccountError
from phone_account_signing import passport_components
from phone_account_medusa import medusa
from phone_account_medusa_digest import selector
from phone_account_transport import region_headers
from phone_account_favorites import request_context, reading_minimal_headers

HOST = 'api5-normal-lq.fqnovel.com'
PATH = '/reading/reader/upload/picture/'
MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000
WRITES_ENABLED = True
UNKNOWN = {'state': 'unknown', 'message': '图片上传结果尚未确认，未发送评论，也不会自动重试。'}


@dataclass(frozen=True)
class PreparedPicture:
    content: bytes
    format: str
    width: int
    height: int

    @property
    def digest(self):
        return hashlib.sha256(self.content).hexdigest()


def prepare(data_url):
    if not isinstance(data_url, str) or len(data_url) > MAX_BYTES * 4 // 3 + 128:
        raise AccountError('图片不能超过8MB，尚未上传')
    match = re.fullmatch(r'data:image/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})', data_url)
    if not match: raise AccountError('请选择PNG或JPEG静态图片，尚未上传')
    try:
        content = base64.b64decode(match[2], validate=True)
        if not content or len(content) > MAX_BYTES: raise ValueError()
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as image:
                actual = 'jpeg' if image.format == 'JPEG' else 'png' if image.format == 'PNG' else ''
                if actual != match[1] or getattr(image, 'n_frames', 1) != 1:
                    raise ValueError()
                if min(image.size) < 1 or image.width * image.height > MAX_PIXELS: raise ValueError()
                image.load()
                rotated = ImageOps.exif_transpose(image)
                rotated.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
                # Fresh pixels prevent EXIF/GPS/comments/profile data from surviving.
                mode = 'RGBA' if actual == 'png' and ('A' in rotated.getbands() or 'transparency' in rotated.info) else 'RGB'
                pixels = rotated.convert(mode)
                clean = Image.frombytes(mode, pixels.size, pixels.tobytes())
                output = io.BytesIO()
                clean.save(output, format='JPEG' if actual == 'jpeg' else 'PNG', **({'quality': 90} if actual == 'jpeg' else {}))
                result = output.getvalue()
                if len(result) > MAX_BYTES: raise ValueError()
                return PreparedPicture(result, actual, clean.width, clean.height)
    except (ValueError, OSError, SyntaxError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise AccountError('图片无法读取或超过1600万像素，请换一张PNG或JPEG静态图片，尚未上传') from None


def multipart(picture, boundary=None):
    if not isinstance(picture, PreparedPicture) or picture.format not in ('jpeg', 'png'):
        raise AccountError('图片尚未准备好')
    if not picture.content or len(picture.content) > MAX_BYTES: raise AccountError('图片大小无效')
    boundary = boundary or 'hongguo-' + secrets.token_hex(24)
    if not re.fullmatch(r'[A-Za-z0-9-]{16,80}', boundary) or boundary.encode() in picture.content:
        raise AccountError('图片请求边界无效，尚未上传')
    extension = 'jpg' if picture.format == 'jpeg' else 'png'
    head = (f'--{boundary}\r\nContent-Disposition: form-data; name="picture"; filename="picture.{extension}"\r\n'
            f'Content-Type: image/{picture.format}\r\n\r\n').encode('ascii')
    return head + picture.content + f'\r\n--{boundary}--\r\n'.encode('ascii'), 'multipart/form-data; boundary=' + boundary


def safe_picture_url(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 4096 or any(ord(c) < 33 for c in value): return ''
    try:
        parts = urlsplit(value)
        host = (parts.hostname or '').lower()
        if parts.scheme != 'https' or parts.username or parts.password or parts.port not in (None,443) or parts.fragment: return ''
        if not any(host == root or host.endswith('.' + root) for root in ('fqnovelpic.com','byteimg.com','pstatp.com','ibytedtos.com')): return ''
        return value
    except ValueError: return ''


def parse_receipt(root, picture):
    if not isinstance(root, dict): return dict(UNKNOWN)
    code = root.get('code')
    data = root.get('data')
    if isinstance(data, dict) and data.get('error_code') not in (None, 0, '0'): code = data['error_code']
    if type(code) not in (str,int) or not re.fullmatch(r'-?[0-9]{1,6}',str(code)): return dict(UNKNOWN)
    if str(code) != '0': return {'state':'rejected','message':f'红果未接受图片（错误码 {code}），未发送评论。'}
    if not isinstance(data, dict): return dict(UNKNOWN)
    # The public upload response exposes web_uri/data; synthetic protocol evidence
    # chooses a returned HTTPS image URL as web_uri for this uploaded-image type.
    url = safe_picture_url(data.get('data')) or safe_picture_url(data.get('web_uri'))
    if not url: return dict(UNKNOWN)
    return {'state':'accepted','message':'图片已上传，评论尚未发送。',
            'image':{'web_uri':url,'width':picture.width,'height':picture.height,'image_type':1,'format':picture.format}}


def signed_request(context, picture, now_ms=None, boundary=None):
    body, content_type = multipart(picture, boundary)
    context = request_context(context)
    params = {str(k):str(v) for k,v in context['params'].items() if k != 'tt_data'}
    params['need_encrypt'] = '0'
    ms = int(time.time()*1000) if now_ms is None else now_ms
    seconds = ms // 1000
    params['ts'] = str(seconds)
    for nonce in range(256):
        params['_rticket'] = str(ms + nonce)
        query = urlencode(sorted(params.items())).encode()
        if (selector(hashlib.new('sm3',query).digest(),hashlib.md5(body).digest(),seconds)&15)%3 == 2: break
    else: raise AccountError('图片签名未准备好，尚未上传')
    headers = passport_components(query,body,seconds)
    headers.update({'X-Medusa':medusa(query,body,seconds,params['device_id']), 'User-Agent':context['user_agent'],
                    'X-SS-DP':'8662','X-SS-REQ-TICKET':params['_rticket'],'Accept':'application/json','Content-Type':content_type})
    return 'https://' + HOST + PATH + '?' + query.decode(), reading_minimal_headers(headers), body


def upload(flow, picture, before_send, *, client_factory=requests.Session):
    if not WRITES_ENABLED: raise AccountError('图片上传尚未接通，评论未发送')
    if not flow.uid or not flow.transport.authenticated_cookies(): raise AccountError('请先登录红果账号')
    url, headers, body = signed_request(flow.transport.context,picture)
    cookies = {c.name:c.value for c in flow.transport.client.cookies}
    headers.update(region_headers(cookies))
    if flow.transport.token: headers['X-TT-Token'] = flow.transport.token
    if cookies.get('passport_csrf_token'): headers['X-TT-Passport-Csrf-Token'] = cookies['passport_csrf_token']
    headers['X-Reading-Request'] = str(int(time.time()*1000)) + '-' + str(100000000+secrets.randbelow(900000000))
    client = client_factory()
    try:
        client.trust_env=False;client.auth=None;client.cookies.clear();client.headers.clear()
        for name,value in cookies.items(): client.cookies.set(name,value,domain=HOST,path='/')
        if client.get_adapter(url).max_retries.total != 0: raise AccountError('图片上传不允许自动重试')
        prepared = client.prepare_request(requests.Request('POST',url,headers=headers,data=body))
        if prepared.url != url or prepared.body != body: raise AccountError('图片编码变化，尚未上传')
        # Caller persists account-bound uncertainty BEFORE any transmission.
        before_send()
        started=time.monotonic()
        with client.send(prepared,timeout=(8,20),allow_redirects=False,stream=True) as response:
            if response.status_code != 200: return dict(UNKNOWN)
            chunks=[];size=0
            for chunk in response.iter_content(32768):
                size+=len(chunk)
                if size>2*1024*1024 or time.monotonic()-started>30: return dict(UNKNOWN)
                chunks.append(chunk)
            return parse_receipt(json.loads(b''.join(chunks)),picture)
    except (requests.RequestException,ValueError,TypeError): return dict(UNKNOWN)
    finally: client.close()
