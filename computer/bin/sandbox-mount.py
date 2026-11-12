#!/usr/bin/env python3
# Bind-mount a thread's directories into its running container (work 103,
# "Mount helper"). The host runs it as the runner user, inside Podman's user
# namespace, after every start of the container:
#
#   SP_DATA=<dir> podman unshare python3 -I sandbox-mount.py <pid> <id> <person> <src>:<dst>...
#
# <pid> is the container's first process as the host sees it, <id> the runner
# id (16 hex), <person> the person's directory name. Each <src> is a directory
# on the host and each <dst> a path in the container, both absolute and
# written without `.`, `..` or empty components. Pairs are mounted in the
# order given: a parent before what is mounted inside it.
#
# Exit: 0 done; 2 bad arguments, or a source outside the roots or through a
# link; 3 the pid is gone or is not that container; 4 a system call failed.
# A failure prints one line on stderr, `<call> <path>: <reason>`.
#
# Invariants:
# - a source is opened below $SP_DATA/people/<person> or $SP_DATA/journals
#   and nowhere else, and no symlink is followed on the way (openat2 with
#   RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS);
# - the pid is that container: the first `sp-runner-*.service` component of
#   its cgroup is `sp-runner-<id>.service` (a session can make cgroups of any
#   name below its own unit, so only the first counts), checked before any
#   source is opened and again after the namespaces are entered. Both reads,
#   and both namespaces, come from one /proc/<pid> opened while a pidfd held
#   the process, so a recycled pid cannot stand in;
# - no symlink is followed in the container either: a destination is walked
#   from `/` one component at a time (RESOLVE_IN_ROOT | RESOLVE_NO_SYMLINKS);
# - a destination that is already a mount root is left alone, so a second run
#   with the same arguments changes nothing;
# - mounts made before a failure stay: the caller stops the container, which
#   discards them;
# - one thread, always: setns(CLONE_NEWUSER) refuses a process with more.
#   Standard library and ctypes only, and no import that starts a thread.

import ctypes
import errno
import os
import platform
import re
import select
import struct
import sys

# Not in every architecture's table at the same number: statx. The others are
# from the range that is shared (asm-generic, Linux 5.2 to 5.6).
SYS_STATX = {'x86_64': 332, 'aarch64': 291}
SYS_OPEN_TREE = 428
SYS_MOVE_MOUNT = 429
SYS_OPENAT2 = 437

AT_EMPTY_PATH = 0x1000
AT_RECURSIVE = 0x8000
OPEN_TREE_CLONE = 0x1
OPEN_TREE_CLOEXEC = os.O_CLOEXEC
MOVE_MOUNT_F_EMPTY_PATH = 0x4
MOVE_MOUNT_T_EMPTY_PATH = 0x40
RESOLVE_NO_MAGICLINKS = 0x02
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08
RESOLVE_IN_ROOT = 0x10
STATX_ATTR_MOUNT_ROOT = 0x2000
CLONE_NEWNS = 0x00020000
CLONE_NEWUSER = 0x10000000

DIR = os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC
UNIT = re.compile(r'sp-runner-[^/]*\.service')

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class Fail(Exception):
    """Exit with `code` after printing `<call> <path>: <reason>`."""

    def __init__(self, code, call, path, reason):
        super().__init__(f'{call} {path}: {reason}')
        self.code = code


def failed(call, path, code=4):
    """The Fail for the system call that just set errno."""
    return Fail(code, call, path, os.strerror(ctypes.get_errno()))


def openat2(dirfd, path, resolve):
    """A directory below `dirfd`, as an O_PATH descriptor; -1 with errno set."""
    how = struct.pack('QQQ', DIR, 0, resolve)
    return libc.syscall(ctypes.c_long(SYS_OPENAT2), ctypes.c_int(dirfd), ctypes.c_char_p(os.fsencode(path)), ctypes.c_char_p(how), ctypes.c_size_t(len(how)))


def is_mount_root(fd, path):
    buf = ctypes.create_string_buffer(256)
    nr = SYS_STATX[platform.machine()]
    if libc.syscall(ctypes.c_long(nr), ctypes.c_int(fd), ctypes.c_char_p(b''), ctypes.c_int(AT_EMPTY_PATH), ctypes.c_uint(0), buf) != 0:
        raise failed('statx', path)
    attributes, known = struct.unpack_from('Q', buf, 8)[0], struct.unpack_from('Q', buf, 56)[0]
    if not known & STATX_ATTR_MOUNT_ROOT:
        raise Fail(4, 'statx', path, 'the kernel does not report STATX_ATTR_MOUNT_ROOT')
    return bool(attributes & STATX_ATTR_MOUNT_ROOT)


def parts(path):
    """The components of an absolute path written plainly, else None."""
    if not path.startswith('/') or '\0' in path:
        return None
    names = path[1:].split('/')
    return None if any(n in ('', '.', '..') for n in names) else names


def check_container(procfd, pidfd, pid, unit):
    """Exit 3 unless the process is alive and its cgroup's first runner unit is `unit`."""
    where = f'/proc/{pid}/cgroup'
    try:
        fd = os.open('cgroup', os.O_RDONLY | os.O_CLOEXEC, dir_fd=procfd)
        with os.fdopen(fd, 'rb') as f:
            text = f.read().decode('utf-8', 'replace')
    except OSError as e:
        raise Fail(3, 'open', where, e.strerror) from None
    if select.select([pidfd], [], [], 0)[0]:
        raise Fail(3, 'pidfd_open', pid, 'the process has exited')
    for line in text.splitlines():
        # hierarchy-id:controllers:path; a path may hold colons.
        fields = line.split(':', 2)
        found = [c for c in fields[2].split('/') if UNIT.fullmatch(c)] if len(fields) == 3 else []
        if found:
            if found[0] == unit:
                return
            raise Fail(3, 'cgroup', where, f'in {found[0]}, not {unit}')
    raise Fail(3, 'cgroup', where, f'not in {unit}')


def open_source(src, roots):
    """A detached copy of the mount tree at `src`, which must lie below one of `roots`."""
    for root in roots:
        if not src.startswith(root + '/'):
            continue
        try:
            rootfd = os.open(root, DIR | os.O_NOFOLLOW)
        except OSError as e:
            raise Fail(4, 'open', root, e.strerror) from None
        fd = openat2(rootfd, src[len(root) + 1 :], RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)
        if fd < 0:
            # ELOOP: a link on the way. EXDEV: the path left the root.
            raise failed('openat2', src, 2 if ctypes.get_errno() in (errno.ELOOP, errno.EXDEV) else 4)
        flags = AT_EMPTY_PATH | OPEN_TREE_CLONE | AT_RECURSIVE | OPEN_TREE_CLOEXEC
        tree = libc.syscall(ctypes.c_long(SYS_OPEN_TREE), ctypes.c_int(fd), ctypes.c_char_p(b''), ctypes.c_uint(flags))
        if tree < 0:
            raise failed('open_tree', src)
        os.close(fd)
        os.close(rootfd)
        return tree
    raise Fail(2, 'source', src, 'not below ' + ' or '.join(roots))


def open_target(dst):
    """The directory `dst` in the mount namespace this process is in, made where missing."""
    try:
        fd = os.open('/', DIR)
    except OSError as e:
        raise Fail(4, 'open', '/', e.strerror) from None
    at = ''
    for name in parts(dst):
        at += '/' + name
        resolve = RESOLVE_IN_ROOT | RESOLVE_NO_SYMLINKS
        nxt = openat2(fd, name, resolve)
        if nxt < 0 and ctypes.get_errno() == errno.ENOENT:
            if libc.mkdirat(ctypes.c_int(fd), ctypes.c_char_p(os.fsencode(name)), ctypes.c_uint(0o755)) != 0 and ctypes.get_errno() != errno.EEXIST:
                raise failed('mkdirat', at)
            nxt = openat2(fd, name, resolve)
        if nxt < 0:
            raise failed('openat2', at)
        os.close(fd)
        fd = nxt
    return fd


def setns(procfd, name, kind, pid):
    where = f'/proc/{pid}/ns/{name}'
    try:
        fd = os.open(f'ns/{name}', os.O_RDONLY | os.O_CLOEXEC, dir_fd=procfd)
    except OSError as e:
        raise Fail(3 if e.errno in (errno.ENOENT, errno.ESRCH) else 4, 'open', where, e.strerror) from None
    if libc.setns(ctypes.c_int(fd), ctypes.c_int(kind)) != 0:
        raise failed('setns', where)
    os.close(fd)


def main(argv):
    usage = 'sandbox-mount.py <pid> <id> <person> <src>:<dst>...'
    if len(argv) < 4:
        raise Fail(2, 'usage', usage, 'too few arguments')
    pid, runner, person, pairs = argv[0], argv[1], argv[2], []
    if not re.fullmatch(r'[1-9][0-9]{0,9}', pid):
        raise Fail(2, 'usage', pid, 'not a pid')
    if not re.fullmatch(r'[0-9a-f]{16}', runner):
        raise Fail(2, 'usage', runner, 'not a runner id')
    if parts('/' + person) != [person]:
        raise Fail(2, 'usage', person, 'not a directory name')
    for pair in argv[3:]:
        src, _, dst = pair.partition(':')
        if not parts(src) or not parts(dst):
            raise Fail(2, 'usage', pair, 'not <src>:<dst>, both absolute and without ., .. or empty components')
        pairs.append((src, dst))
    data = os.environ.get('SP_DATA', '')
    if not parts(data):
        raise Fail(2, 'usage', 'SP_DATA', 'not set to an absolute path')
    if platform.machine() not in SYS_STATX:
        raise Fail(4, 'uname', platform.machine(), 'no system call numbers for this architecture')
    roots = [f'{data}/people/{person}', f'{data}/journals']
    unit = f'sp-runner-{runner}.service'
    os.umask(0o022)

    # 1. The process, held, and that it is the container.
    try:
        pidfd = os.pidfd_open(int(pid))
    except OSError as e:
        raise Fail(3 if e.errno == errno.ESRCH else 4, 'pidfd_open', pid, e.strerror) from None
    try:
        procfd = os.open(f'/proc/{pid}', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except OSError as e:
        raise Fail(3, 'open', f'/proc/{pid}', e.strerror) from None
    check_container(procfd, pidfd, pid, unit)

    # 2. Every source, while this is still the host's view of the files.
    trees = [open_source(src, roots) for src, _ in pairs]

    # 3. Into the container. After the second call `/` and /proc are the
    # container's, so the check reads through the descriptor opened above.
    setns(procfd, 'user', CLONE_NEWUSER, pid)
    setns(procfd, 'mnt', CLONE_NEWNS, pid)
    check_container(procfd, pidfd, pid, unit)

    # 4. Each tree onto its place.
    for (_, dst), tree in zip(pairs, trees):
        fd = open_target(dst)
        if not is_mount_root(fd, dst):
            flags = MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH
            if libc.syscall(ctypes.c_long(SYS_MOVE_MOUNT), ctypes.c_int(tree), ctypes.c_char_p(b''), ctypes.c_int(fd), ctypes.c_char_p(b''), ctypes.c_uint(flags)) != 0:
                raise failed('move_mount', dst)
        os.close(fd)
        os.close(tree)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Fail as e:
        sys.stderr.write(f'{e}\n')
        sys.exit(e.code)
