"""Independent Medusa wire serialization, isolated from playback transport."""
import base64
import struct
import hashlib
import secrets
import re

from phone_account_medusa_cipher import MedusaCipher, derive_scramble_key, scramble, xor
from phone_account_medusa_digest import digest_branch_two

PREFIX=bytes.fromhex('4001000000000000')
SEED=bytes.fromhex('8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5')
KEY=bytes.fromhex('f1593376766ea98d34f31b057a9d5be4')
IV=bytes.fromhex('1fe109a4125283f418de9e051a969e12')
VERSION=bytes.fromhex('050000002d4b4fca49750d433fb5ae2c226dcc56')


def varint(value):
    if not 0 <= value < 1 << 64: raise ValueError('invalid-protobuf-number')
    out=bytearray()
    while value>127:
        out.append((value&127)|128);value>>=7
    return bytes(out)+bytes((value,))


def protobuf(fields):
    out=bytearray()
    for field,value in fields:
        if isinstance(value,int):out+=varint(field<<3)+varint(value)
        elif isinstance(value,float):out+=varint((field<<3)|5)+struct.pack('<f',value)
        else:
            if isinstance(value,str):value=value.encode('utf8')
            if value:out+=varint((field<<3)|2)+varint(len(value))+value
    return bytes(out)


def device_proof(device_id):
    # Public SDK wire defaults, not a borrowed account/device identity. The only
    # registration binding is our independently issued device_id (field 4).
    return protobuf([(1,2),(2,4),(3,'8662'),(4,device_id),
        (5,'Ai6svO3PyrwDOUSmO6ZcResxu'),(6,'!noperm!'),(7,1777775),(8,1777775),
        (9,6),(10,1777775),(11,'!notset!'),(12,'Asia/Shanghai,8'),(13,'zh_CN'),(14,8),
        (16,255.24993896484375),(17,35.58599090576172),(18,3.467449188232422),
        (19,3.467449188232422),(20,255.1754913330078),(21,42.17544174194336),
        (22,'16'),(23,82),(24,72),(25,3456776033270),(26,3456776033270),
        (27,3456776033270),(28,3456776033274),(29,1),(30,'25053RT47C'),(31,'Redmi'),
        (32,'25053RT47C'),(33,'25053RT47C'),(34,'Xiaomi'),(35,'Redmi'),(36,'Redmi'),(38,62)])


def proof_message(query,body,seconds,device_id,nonce,body_proof=None,*,version_name='7.3.9.32',proof_identity='none'):
    if not isinstance(version_name,str) or not re.fullmatch(r'[0-9]{1,3}(?:\.[0-9]{1,3}){2,3}',version_name):
        raise ValueError('invalid-app-version')
    if not isinstance(proof_identity,str) or not 1<=len(proof_identity)<=128 or any(ord(c)<32 or ord(c)>126 for c in proof_identity):
        raise ValueError('invalid-proof-identity')
    digest=hashlib.new('sm3',query).digest()
    body_digest=hashlib.md5(body).digest() if body else bytes(16)
    proof=body_proof or digest_branch_two(digest,body_digest,seconds)
    sdk=protobuf([(1,202),(2,292662798),(3,292662792),(5,14),(6,'v04.06.04.03-bugfix'),
        (7,20004),(12,device_proof(device_id)),
        (13,protobuf([(1,seconds*2),(2,3),(4,400)])),(14,version_name)])
    flags='{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}'
    return protobuf([(1,bytes.fromhex('f7e85ffad7d7dc3bd62ac87057cf6118')),(2,6),
        (3,nonce*2),(4,'8662'),(5,device_id),(6,'1588093228'),(7,version_name),
        (8,'v04.06.04-ml-android'),(9,135006208),(10,PREFIX),(12,seconds*2),(13,proof),
        (14,digest[:6]),(15,protobuf([(1,222),(2,20),(3,1388734),(5,1173904398)])),
        (16,'AXYQOS6n2m60x1fVZHIrH3iol'),(17,seconds*2),
        (19,hashlib.new('sm3',query+body_digest+b'none').digest()),(20,proof_identity),(21,624),
        (23,sdk),(24,flags)])


def medusa(query,body,seconds,device_id,nonces=None,*,version_name='7.3.9.32'):
    nonces=nonces or tuple(secrets.randbits(32) for _ in range(3))
    if len(nonces)!=3 or any(not 0<=v<=0xffffffff for v in nonces):
        raise ValueError('invalid-medusa-nonce')
    digest=hashlib.new('sm3',query).digest()
    proof=digest_branch_two(digest,hashlib.md5(body).digest() if body else bytes(16),seconds)
    message=proof_message(query,body,seconds,device_id,nonces[0],proof,version_name=version_name)
    return envelope(message,digest,proof,seconds,nonces[1],nonces[2])


def envelope(proto, query_digest, body_proof, seconds, key_nonce, frame_nonce):
    key, mask=derive_scramble_key(SEED,key_nonce)
    mixed=bytes(reversed(PREFIX+scramble(proto,key)))
    mixed=bytes(value ^ mask[(~index)&3] for index,value in enumerate(mixed))
    flags=0x18000001 | ((query_digest[0]&63)<<14) | ((body_proof[0]&63)<<8)
    payload=b'\x35'+struct.pack('<II',frame_nonce,flags)+mixed+struct.pack('<H',key_nonce>>16)
    wrapped=MedusaCipher(KEY,seconds).wrap(payload,IV)
    header=xor(VERSION,struct.pack('<I',seconds)*5)
    return base64.b64encode(header+struct.pack('<H',key_nonce&65535)+b'\x00\x01'+wrapped).decode('ascii')
