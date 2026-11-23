"""Independent implementation of the Medusa wire cipher's matrix operations.

This is not AES: the protocol uses custom substitution/permutation tables, two
rounds, and altered key scheduling. Kept separate from normal cryptographic code.
Validated only by synthetic offline vectors; not an authenticated server result.
"""
import base64
import json
from pathlib import Path
import struct
import hashlib

TABLES = json.loads(Path(__file__).with_name('medusa_wire_tables.json').read_text())['variants']
CONSTANTS = (0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f)


def xor(a, b):
    if len(a) != len(b): raise ValueError('length-mismatch')
    return bytes(x ^ y for x, y in zip(a, b))


def twice(value):
    return ((value << 1) ^ (0x11b if value & 128 else 0)) & 255


def rotate_byte(value, bits):
    value &= 255
    return ((value << bits) | (value >> (8-bits))) & 255


def derive_scramble_key(seed, nonce):
    digest = hashlib.new('sm3', seed + struct.pack('<I',nonce) + seed).digest()
    byte = (nonce >> 16) & 255
    mask = ~((((nonce >> 5) & 0x7f800) | (nonce >> 24)) ^ (byte >> 5) ^ byte) & 0xffffffff
    return digest, struct.pack('<I',mask)


def scramble(payload, key):
    if len(payload)<4 or len(key)!=32: raise ValueError('invalid-scramble-input')
    transformed=[]
    for index,value in enumerate(payload):
        a,b=key[(index%8)*4:(index%8)*4+2]
        middle=rotate_byte((~(rotate_byte(value,4)+a)) ^ b,3)
        transformed.append(~((middle+b)^a)&255)
    out=bytearray(reversed(transformed))
    original_first=out[0]
    edge=out[-1]^out[-2]
    out[0]=(out[0]+(~edge&255))&255
    out[1]=(out[1]+((out[-1]^out[0]^0xfe)&255))&255
    out[2]=(out[2]+(((edge-original_first)&255)^rotate_byte(out[1],3)^2))&255
    for index in range(3,len(out)-1):
        out[index]=(out[index]+(~(out[index-2]^rotate_byte(out[index-1],3)^index)&255))&255
    out[-1]^=out[-2]
    out[0]=((out[0]^out[1])+sum(out[1:]))&255
    return bytes(out)


class MedusaCipher:
    def __init__(self, key: bytes, seconds: int):
        if len(key) != 16: raise ValueError('invalid-wire-key')
        variant = seconds % 4
        self.box = base64.b64decode(TABLES[variant]['box'])
        self.rows, self.shift = TABLES[variant]['rows'], TABLES[variant]['shift']
        constant = CONSTANTS[variant]
        initial = xor(key, struct.pack('<I', constant) * 4)
        words = [initial[i:i+4] for i in range(0,16,4)]
        for i in range(4,12):
            word = words[-1]
            if i % 4 == 0:
                word = bytearray(self.box[v] for v in word[1:] + word[:1])
                word[0] ^= (constant >> ((2*i) & 24)) & 255
            words.append(xor(words[i-4], word))
        self.keys = [b''.join(words[i:i+4]) for i in range(0,12,4)]

    def _add_key(self, state, key):
        return bytes(state[row*4+col] ^ key[row*4+self.rows[col]]
                     for row in range(4) for col in range(4))

    def block(self, block):
        if len(block) != 16: raise ValueError('invalid-block')
        state = self._add_key(block, self.keys[0])
        for step in (1,2):
            sub = bytes(self.box[v] for v in state)
            reordered = b''.join(sub[row*4:row*4+4] for row in self.rows)
            state = bytes(reordered[i] for i in self.shift)
            if step == 1:
                state = bytes(state[row*4+self.rows[col]] for row in range(4) for col in range(4))
                output = bytearray(16)
                for col in range(4):
                    column = [state[row*4+col] for row in range(4)]
                    total = column[0] ^ column[1] ^ column[2] ^ column[3]
                    for row in range(4):
                        output[row*4+col] = column[row] ^ total ^ twice(column[row] ^ column[(row+1)%4])
                state = bytes(output)
            state = self._add_key(state, self.keys[step])
        return xor(state, self.keys[1])

    def wrap(self, payload, iv):
        if len(payload)<248 or len(iv)!=16: raise ValueError('invalid-wire-envelope')
        source_bits=(5,6,2,4,3,1,0,7)
        packed_bits=(1,6,0,7,2,4,5,3)
        sampled=bytes(sum(((payload[group*8+j]>>source_bits[j])&1)<<packed_bits[j]
                          for j in range(8)) for group in range(31))+b'\x01'
        previous=iv; encrypted=b''
        for index in (0,16):
            previous=self.block(xor(sampled[index:index+16],previous))
            encrypted+=previous
        out=bytearray(payload)
        for group in range(31):
            for j in range(8):
                bit=source_bits[j]
                out[group*8+j]=(out[group*8+j]&~(1<<bit))|(((encrypted[group]>>packed_bits[j])&1)<<bit)
        return encrypted[-1:]+out
