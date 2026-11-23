"""Independent parametrized digest for Medusa branch 2, with offline vectors.

The request builder must bind the selected branch to the final encoded query.
Other branches are rejected rather than silently signed with another algorithm.
"""
import hashlib
import json
from pathlib import Path
import struct

PARAMETERS=json.loads(Path(__file__).with_name('medusa_wire_tables.json').read_text())
INDICES=bytes.fromhex(PARAMETERS['digestIndices'])
ROUND_CONSTANTS=PARAMETERS['digestRoundConstants']
MASK=0xffffffff


def rotate(value, bits):
    value &= MASK; bits %= 32
    return ((value << bits) | (value >> ((32-bits)%32))) & MASK


def selector(query_digest, body_digest, seconds):
    value=0x20230928
    for part in (query_digest,body_digest,struct.pack('<I',seconds)):
        for index,byte in enumerate(part):
            if index%2:
                value=~(value^(value>>7)^((value<<12)|byte))&MASK
            else:
                value=(value^(value>>4)^(value<<6)^byte)&MASK
    return value


def checksum(value):
    result=0x20220420
    for index,byte in enumerate(value[:12]):
        if index%2:
            result=(result^(result>>5)^~((result<<11)|byte))&MASK
        else:
            result=(result^(result>>3)^(result<<7)^byte)&MASK
    return ((result|4)^0x01000000)&MASK


def digest_branch_two(query_digest,body_digest,seconds):
    choice=selector(query_digest,body_digest,seconds)
    if (choice&15)%3!=2: raise ValueError('unsupported-digest-branch')
    variant=((choice&13)*86)>>8
    bias=(0x8980f29b,0xeb549c7f,0xb08726db,0xd40cb5e6,0xe8f559e4)[variant]
    seed=(seconds+bias)&MASK
    suffix=bytes(((v>>((seed+5)&7))|(v<<(8-((seed+5)&7))))&255
                 for v in bytes.fromhex('8496779dd4150bf8'))
    message=query_digest+body_digest+struct.pack('<I',seconds)+suffix+struct.pack('<I',416)
    words=struct.unpack('<16I',message)
    iv=[rotate(v,-seed) for v in (0x79e0f2fb,0xc8b52570,0xebc2f8cd,0x7c104d93)]
    finish=[rotate(v,-((seed+6)&255)) for v in (0x19be4866,0xe85986b4,0xe19b326e,0x71d1d7d4)]
    a,b,c,d=iv
    schedule=INDICES[variant*64:(variant+1)*64]
    shifts=((7,12,17,22),(5,9,14,20),(4,11,16,23),(6,10,15,21))
    for step in range(64):
        phase=step//16
        if phase==0: f=(b&c)|(~b&d)
        elif phase==1: f=(b&d)|(c&~d)
        elif phase==2: f=b^c^d
        else: f=c^(b|~d)
        constant=rotate(ROUND_CONSTANTS[step],-((seed+1)&255))
        result=(b+rotate(a+f+words[schedule[step]]+constant,shifts[phase][step%4]))&MASK
        a,d,c,b=d,c,b,result
    final=struct.pack('<4I',*[((v+i)&MASK)^f for v,i,f in zip((a,b,c,d),iv,finish)])
    return final+struct.pack('<I',checksum(final))
