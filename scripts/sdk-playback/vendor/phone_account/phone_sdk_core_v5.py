"""Path-independent bounded ARM64 SDK digest adapter.

Reuses this project's independently implemented, vector-checked emulator.
The caller supplies a hash-verified original SDK image; this module contains no
SDK asset, device/account access, filesystem or network imports. It models no
Java environment and stops at the digest core boundary, not a full Android app.
Unicorn must be provided by the packaged runtime. No analysis-folder fallback.
"""
import hashlib
import struct
import time

from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_INVALID, UC_HOOK_INTR, UC_HOOK_MEM_READ, UC_PROT_READ
from unicorn.arm64_const import *

EXPECTED = 'c6831ab265a0cb76dacfa3b7041e9ea0f706490106a74e12f39058671cc14fe3'


class SdkDigestCore:
    BASE = 0x1000000
    HEAP = 0x2000000
    STACK = 0x3000000
    IMPORT = 0x4000000
    STOP = 0x5000000

    def __init__(self, image):
        if not isinstance(image, bytes) or len(image) != 4501136 or hashlib.sha256(image).hexdigest() != EXPECTED:
            raise ValueError('unsupported-original-sdk-image')
        self.u = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        self.stop_at_core = True
        # This bounded adapter models unavailable environment pointers as
        # empty data. Keep that explicit and read-only, record every access,
        # and never use this analysis setup as proof of a native Android run.
        self.u.mem_map(0, 0x1000, UC_PROT_READ)
        self.empty_environment_reads = 0
        self.u.hook_add(UC_HOOK_MEM_READ, self.empty_environment_read, begin=0, end=0xfff)
        self.u.mem_map(self.BASE, 0x500000)
        self.u.mem_map(self.HEAP, 0x800000)
        self.u.mem_map(self.STACK, 0x200000)
        self.u.mem_map(self.IMPORT, 0x10000)
        self.u.mem_map(self.STOP, 0x1000)
        self.heap = self.HEAP
        self.allocations = {}
        self.calls = {}
        self.mutex_depth = {}
        self.once_done = set()
        self.once_pending = []
        self.thread_keys = {}
        self.thread_destructors = []
        self.syscalls = []
        self.errno_address = self.alloc(4)
        self.missing = None
        phoff = struct.unpack_from('<Q', image, 32)[0]
        stride, count = struct.unpack_from('<HH', image, 54)
        for index in range(count):
            kind, _, offset, address, _, size, _, _ = struct.unpack_from('<IIQQQQQQ', image, phoff + index * stride)
            if kind == 1:
                self.u.mem_write(self.BASE + address, image[offset:offset + size])
        shoff = struct.unpack_from('<Q', image, 40)[0]
        stride, count, string_index = struct.unpack_from('<HHH', image, 58)
        sections = [struct.unpack_from('<IIQQQQIIQQ', image, shoff + i * stride) for i in range(count)]
        table = sections[string_index]
        names = image[table[4]:table[4] + table[5]]
        text = lambda buf, start: buf[start:buf.index(b'\0', start)].decode()
        sections_by_name = {text(names, item[0]): item for item in sections}
        syms = sections_by_name['.dynsym']
        strings = sections[syms[6]]
        strings = image[strings[4]:strings[4] + strings[5]]
        symbols = [struct.unpack_from('<IBBHQQ', image, syms[4] + i) for i in range(0, syms[5], syms[9])]
        self.imports = {}
        for name in ['.rela.dyn', '.rela.plt']:
            section = sections_by_name[name]
            for pos in range(section[4], section[4] + section[5], 24):
                address, info, addend = struct.unpack_from('<QQq', image, pos)
                symbol, kind = info >> 32, info & 0xffffffff
                if kind == 1027:
                    value = self.BASE + addend
                elif kind in (1025, 1026, 257):
                    entry = symbols[symbol]
                    if entry[3]:
                        value = self.BASE + entry[4] + addend
                    else:
                        value = self.IMPORT + symbol * 128
                        self.imports[value] = text(strings, entry[0])
                else:
                    raise RuntimeError(f'unsupported relocation {kind}')
                self.u.mem_write(self.BASE + address, struct.pack('<Q', value))
        # Model the absence of a Java environment through the SDK's normal
        # JavaVM error result. Never provide Java objects or account context.
        vm_table = self.alloc(64)
        self.u.mem_write(vm_table + 0x20, struct.pack('<Q', self.IMPORT + 0xf100))
        self.u.mem_write(vm_table + 0x30, struct.pack('<Q', self.IMPORT + 0xf110))
        vm_object = self.alloc(struct.pack('<Q', vm_table))
        vm_global = struct.unpack('<Q', self.read(self.BASE + 0x3e8368, 8))[0]
        self.u.mem_write(vm_global, struct.pack('<Q', vm_object))
        self.u.reg_write(UC_ARM64_REG_TPIDR_EL0, self.STACK)
        # Hook only modeled imports. A Python callback on every VM instruction
        # can consume the time budget before the digest has done useful work.
        self.u.hook_add(UC_HOOK_CODE, self.hook, begin=self.IMPORT, end=self.IMPORT + 0xffff)
        self.u.hook_add(UC_HOOK_CODE, self.digest_boundary,
                        begin=self.BASE + 0x17dc48, end=self.BASE + 0x17dc48)
        self.u.hook_add(UC_HOOK_MEM_INVALID, self.invalid_memory)
        self.u.hook_add(UC_HOOK_INTR, self.interrupt)

    def empty_environment_read(self, u, access, address, size, value, data):
        self.empty_environment_reads += 1
        assert self.empty_environment_reads <= 64

    def digest_boundary(self, u, address, size, data):
        instruction_slot = u.reg_read(UC_ARM64_REG_X28)
        instruction = struct.unpack('<Q', self.read(instruction_slot, 8))[0]
        if self.stop_at_core and instruction == self.BASE + 0xecc40:
            self.core_returned = True
            u.emu_stop()

    def interrupt(self, u, number, data):
        call = u.reg_read(UC_ARM64_REG_X8)
        assert number == 2
        if call == 57:
            self.syscalls.append({'call': 'close', 'result': 'EBADF'})
            u.reg_write(UC_ARM64_REG_X0, 0xfffffffffffffff7)
            return
        if call != 56:
            raise RuntimeError(f'Unsupported SDK syscall: {call}')
        pointer = u.reg_read(UC_ARM64_REG_X1)
        path = bytearray()
        for i in range(256):
            byte = self.read(pointer + i, 1)
            if byte == b'\0':
                break
            path.extend(byte)
        else:
            raise RuntimeError('Unbounded SDK path')
        self.syscalls.append({'call': 'openat', 'path': path.decode('utf8'), 'result': 'ENOENT'})
        # No files are exposed to the emulated SDK. Do not proxy to the host.
        u.reg_write(UC_ARM64_REG_X0, 0xfffffffffffffffe)

    def invalid_memory(self, u, access, address, size, value, data):
        self.missing = {'access': access, 'address': hex(address), 'size': size,
                        'pc': hex(u.reg_read(UC_ARM64_REG_PC) - self.BASE)}
        return False

    def alloc(self, value):
        if isinstance(value, int):
            assert 0 <= value <= 2 * 1024 * 1024
            value = bytes(value)
        address = self.heap
        self.heap += (len(value) + 31) // 16 * 16
        assert self.heap < self.HEAP + 0x800000
        self.allocations[address] = len(value)
        self.u.mem_write(address, value)
        return address

    def read(self, address, count):
        assert 0 <= count <= 2 * 1024 * 1024
        return bytes(self.u.mem_read(address, count))

    def hook(self, u, address, size, data):
        if address in (self.IMPORT + 0xf100, self.IMPORT + 0xf110):
            self.calls['JNI_environment_unavailable'] = self.calls.get('JNI_environment_unavailable', 0) + 1
            u.mem_write(u.reg_read(UC_ARM64_REG_X1), bytes(8))
            u.reg_write(UC_ARM64_REG_X0, 0xffffffff)  # JNI_ERR; no JNIEnv.
            u.reg_write(UC_ARM64_REG_PC, u.reg_read(UC_ARM64_REG_LR))
            return
        if address == self.IMPORT + 0xf000:
            control, previous_lr = self.once_pending.pop()
            self.once_done.add(control)
            u.mem_write(control, struct.pack('<I', 2))
            u.reg_write(UC_ARM64_REG_X0, 0)
            u.reg_write(UC_ARM64_REG_LR, previous_lr)
            u.reg_write(UC_ARM64_REG_PC, previous_lr)
            return
        name = self.imports.get(address)
        if not name:
            return
        self.calls[name] = self.calls.get(name, 0) + 1
        a, b, c, d = [u.reg_read(reg) for reg in [UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2, UC_ARM64_REG_X3]]
        if name in ('malloc', 'calloc'):
            value = self.alloc(a if name == 'malloc' else a * b)
        elif name == 'free':
            value = 0
        elif name == 'realloc':
            value = self.alloc(b)
            if a:
                u.mem_write(value, self.read(a, min(b, self.allocations[a])))
        elif name in ('memcpy', 'memmove', '__memcpy_chk', '__memmove_chk'):
            if name.endswith('_chk'):
                assert c <= d
            u.mem_write(a, self.read(b, c));value = a
        elif name in ('memset', '__memset_chk'):
            assert c <= 2 * 1024 * 1024
            if name.endswith('_chk'):
                assert c <= d
            u.mem_write(a, bytes([b & 255]) * c);value = a
        elif name == 'memcmp':
            left, right = self.read(a, c), self.read(b, c)
            value = (left > right) - (left < right)
        elif name in ('strlen', '__strlen_chk'):
            value = 0
            while self.read(a + value, 1) != b'\0':
                value += 1
                assert value <= 65536
        elif name in ('pthread_mutex_lock', 'pthread_mutex_unlock'):
            # The isolated emulator has exactly one thread; track balanced
            # locking instead of creating or interacting with host mutexes.
            self.read(a, 4)
            depth = self.mutex_depth.get(a, 0)
            if name.endswith('_unlock'):
                assert depth > 0
                depth -= 1
            else:
                depth += 1
            self.mutex_depth[a] = depth
            value = 0
        elif name == 'pthread_cond_broadcast':
            # There are no waiting threads in this single-thread oracle.
            self.read(a, 4)
            value = 0
        elif name == 'pthread_once':
            self.read(a, 4)
            if a not in self.once_done:
                assert self.BASE <= b < self.BASE + 0x500000
                assert all(control != a for control, _ in self.once_pending)
                self.once_pending.append((a, u.reg_read(UC_ARM64_REG_LR)))
                u.reg_write(UC_ARM64_REG_LR, self.IMPORT + 0xf000)
                u.reg_write(UC_ARM64_REG_PC, b)
                return
            value = 0
        elif name == 'pthread_key_create':
            key = len(self.thread_keys) + 1
            self.thread_keys[key] = 0
            u.mem_write(a, struct.pack('<I', key));value = 0
        elif name == 'pthread_setspecific':
            assert a in self.thread_keys
            self.thread_keys[a] = b;value = 0
        elif name == 'pthread_getspecific':
            assert a in self.thread_keys
            value = self.thread_keys[a]
        elif name in ('gettid', 'getpid'):
            value = 1  # Synthetic single-process, single-thread environment.
        elif name == 'syscall' and a in (172, 178):
            value = 1
        elif name == 'clock_gettime':
            assert a in (0, 1)
            u.mem_write(b, struct.pack('<qq', 1700000000 if a == 0 else 1, 0))
            value = 0
        elif name in ('__system_property_find', 'getenv'):
            value = 0  # No Android properties or host environment are exposed.
        elif name == '__errno':
            value = self.errno_address
        elif name == '__cxa_thread_atexit_impl':
            # Retain the registration. No thread exit is emulated and the
            # entire bounded virtual address space is discarded afterward.
            self.thread_destructors.append((a, b, c))
            value = 0
        else:
            raise RuntimeError(f'Import unavailable in pure digest analysis: {name}')
        u.reg_write(UC_ARM64_REG_X0, value & 0xffffffffffffffff)
        u.reg_write(UC_ARM64_REG_PC, u.reg_read(UC_ARM64_REG_LR))

    def digest(self, payload, selector, seconds):
        assert len(payload) == 52 and 0 <= selector < 16 and 0 <= seconds <= 0xffffffff
        pointer = self.alloc(payload + b'\0')
        # This SDK uses its own byte-string class, not libc++ std::string:
        # vtable, uint32 capacity, uint32 length, data pointer.
        argument = self.alloc(struct.pack('<QIIQ', self.BASE + 0x3c8288,
                                          len(payload) + 1, len(payload), pointer))
        result = self.alloc(24)
        self.result_address = result
        self.core_returned = False
        self.u.reg_write(UC_ARM64_REG_SP, self.STACK + 0x1f0000)
        self.u.reg_write(UC_ARM64_REG_X0, argument)
        self.u.reg_write(UC_ARM64_REG_X1, selector)
        self.u.reg_write(UC_ARM64_REG_X2, seconds)
        self.u.reg_write(UC_ARM64_REG_X8, result)
        self.u.reg_write(UC_ARM64_REG_LR, self.STOP)
        started = time.monotonic()
        # The cold SDK builds its lookup tables; a bounded trace confirmed it
        # advances into table completion just beyond the first 30M operations.
        self.u.emu_start(self.BASE + 0x2aac34, self.STOP, timeout=20_000_000, count=100_000_000)
        assert self.core_returned or self.u.reg_read(UC_ARM64_REG_PC) == self.STOP, 'Digest instruction/time budget reached'
        raw = self.read(result, 24)
        _, capacity, length, pointer = struct.unpack('<QIIQ', raw)
        assert length == 20 and capacity >= length, f'Unexpected digest length {length}'
        value = self.read(pointer, length)
        return value, time.monotonic() - started

