"""新版原生helper补充验收：普通并发正常，直接系统调用与环境绕过被拒。"""
import concurrent.futures
import ctypes
import errno
import json
import os
import pathlib
import signal
import subprocess

libc = ctypes.CDLL(None, use_errno=True)
checks = []


def record(name, passed, detail=None):
    checks.append({'name': name, 'passed': bool(passed), 'detail': detail})


with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    record('Python threads work', list(executor.map(lambda x: x * x, [2, 3, 4])) == [4, 9, 16])
result = subprocess.run(['python3', '-c', 'print("CHILD_OK")'], capture_output=True, text=True, timeout=3)
record('Python subprocess works', result.returncode == 0 and result.stdout.strip() == 'CHILD_OK')

for name, flag in [('unshare NEWUSER denied', 0x10000000), ('unshare NEWNS denied', 0x20000)]:
    status = libc.unshare(flag)
    code = ctypes.get_errno()
    record(name, status == -1 and code == errno.EPERM, code)

# 当前候选固定为Linux arm64；不将本架构的系统调用号误用于其他平台。
assert os.uname().machine == 'aarch64'
status = libc.syscall(220, ctypes.c_ulong(0x10000000 | signal.SIGCHLD), 0, 0, 0, 0)
if status == 0:
    os._exit(0)
code = ctypes.get_errno()
if status > 0:
    os.waitpid(status, 0)
record('direct clone NEWUSER denied', status == -1 and code == errno.EPERM, code)
arguments = (ctypes.c_uint64 * 11)()
arguments[0] = 0x10000000
status = libc.syscall(435, ctypes.byref(arguments), ctypes.sizeof(arguments))
if status == 0:
    os._exit(0)
code = ctypes.get_errno()
if status > 0:
    os.waitpid(status, 0)
record('clone3 unavailable with ENOSYS', status == -1 and code == errno.ENOSYS, code)

# 无效fd仍得到EPERM而非EBADF，核对调用被过滤器提前拒绝。
status = libc.setns(-1, 0)
record('setns denied before fd lookup', status == -1 and ctypes.get_errno() == errno.EPERM, ctypes.get_errno())
for name, call in [
    ('mount blocked', lambda: libc.mount(None, b'/workspace', None, 4096 | 32, None)),
    ('umount blocked', lambda: libc.umount2(b'/workspace', 2)),
    ('pivot_root blocked', lambda: libc.syscall(41, b'/workspace', b'/workspace')),
]:
    status = call()
    code = ctypes.get_errno()
    record(name, status == -1 and code == errno.EPERM, code)

result = subprocess.run(['unshare', '-Ur', '/bin/true'], env={**os.environ, 'SRT_ALLOW_NESTED_USERNS': '1'}, capture_output=True, text=True, timeout=3)
record('internal env cannot reopen user namespaces', result.returncode != 0, result.stderr.strip())
status = pathlib.Path('/proc/self/status').read_text()
record('no_new_privs remains enabled', 'NoNewPrivs:\t1' in status)
record('seccomp filtering remains enabled', 'Seccomp:\t2' in status)
print(json.dumps({'checks': checks}))
