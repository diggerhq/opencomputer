#!/usr/bin/env python3
# One terminal's process, as the agent user (work 084; host/terminal.ts starts
# it, in its own systemd unit when the host launches runners that way). Node
# cannot open a pseudo-terminal or pass file descriptors, so this owns the PTY
# (or, with tty false, three pipes) and speaks frames on stdin/stdout:
#
#   frame = type (1 byte) | length (u32 big-endian) | payload
#   in:  S start {cols, rows, command, tty, term, env, cwd, inherit}   D data   R resize {cols, rows}
#        E eof (tty: ^D; pipes: close stdin)   H hang up (stdin closing and SIGHUP count as H)
#   out: O output   X standard error (tty false)   Z exit {exitCode, signal}, last
#
# Invariants: the child's environment is exactly `env` from the start frame
# (no secrets: the host builds it from a fixed list, and BASH_ENV/ENV are never
# set). With `inherit` (work 103: the helper runs inside a session's
# container, by `podman exec`) it is this process's own environment, which is
# the container's and holds no credential, with `env` over it and without
# BASH_ENV and ENV. There a SIGHUP is how the host hangs up a helper whose
# `podman exec` client is gone (`pkill -HUP -f`; extra arguments, the
# terminal's unit name, are only there for it to match). The child leads its
# own session and process group; a hang-up sends SIGHUP to the group (again
# every 0.5 s) and SIGKILL 5 s later; every byte of output is framed before
# `Z`; this process exits right after `Z`.

import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios
import time

KILL_AFTER = 5.0
DRAIN_AFTER_EXIT = 0.2
CHUNK = 65536

out_fd = sys.stdout.fileno()
in_fd = sys.stdin.fileno()


def send(kind, payload):
    data = kind + struct.pack('>I', len(payload)) + payload
    view = memoryview(data)
    while view:
        try:
            n = os.write(out_fd, view)
        except BlockingIOError:
            select.select([], [out_fd], [])
            continue
        view = view[n:]


class Reader:
    def __init__(self):
        self.buf = b''

    def feed(self, chunk):
        self.buf += chunk
        frames = []
        while len(self.buf) >= 5:
            (n,) = struct.unpack('>I', self.buf[1:5])
            if len(self.buf) < 5 + n:
                break
            frames.append((self.buf[0:1], self.buf[5:5 + n]))
            self.buf = self.buf[5 + n:]
        return frames


def winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def start(spec):
    env = {k: v for k, v in os.environ.items() if k not in ('BASH_ENV', 'ENV')} if spec.get('inherit') else {}
    env.update({k: str(v) for k, v in (spec.get('env') or {}).items()})
    env['TERM'] = spec.get('term') or 'xterm-256color'
    shell = env.get('SHELL') or '/bin/bash'
    argv = ['/bin/bash', '-lc', spec['command']] if spec.get('command') else [shell, '-l']
    cwd = spec.get('cwd') or env.get('HOME') or '/'
    if spec.get('tty', True):
        master, slave = os.openpty()
        winsize(slave, int(spec.get('cols') or 80), int(spec.get('rows') or 24))
        pid = os.fork()
        if pid == 0:
            try:
                os.close(master)
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                for fd in (0, 1, 2):
                    os.dup2(slave, fd)
                if slave > 2:
                    os.close(slave)
                os.chdir(cwd)
                signal.signal(signal.SIGHUP, signal.SIG_DFL)
                os.execvpe(argv[0], argv, env)
            finally:
                os._exit(127)
        os.close(slave)
        return pid, {'in': master, 'out': master, 'err': None}
    rin, win = os.pipe()
    rout, wout = os.pipe()
    rerr, werr = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            os.dup2(rin, 0)
            os.dup2(wout, 1)
            os.dup2(werr, 2)
            for fd in (rin, win, rout, wout, rerr, werr):
                os.close(fd)
            os.chdir(cwd)
            signal.signal(signal.SIGHUP, signal.SIG_DFL)  # ignored here; an ignored signal stays ignored across exec
            os.execvpe(argv[0], argv, env)
        finally:
            os._exit(127)
    for fd in (rin, wout, werr):
        os.close(fd)
    return pid, {'in': win, 'out': rout, 'err': rerr}


def main():
    os.set_blocking(in_fd, False)
    reader = Reader()
    pid = None
    fds = None
    tty = True
    status = None
    hup_at = None
    resent = 0
    exited_at = None
    stdin_open = True
    open_out = {}
    # A SIGHUP wakes the loop through a pipe; it is a hang-up.
    hup_r, hup_w = os.pipe()
    os.set_blocking(hup_w, False)
    signal.signal(signal.SIGHUP, lambda *_: os.write(hup_w, b'h'))

    def hang_up():
        nonlocal hup_at
        if pid is None:
            send(b'Z', json.dumps({'exitCode': None, 'signal': 'SIGHUP'}).encode())
            sys.exit(0)
        if hup_at is None:
            hup_at = time.monotonic()
            try:
                os.killpg(pid, signal.SIGHUP)
            except ProcessLookupError:
                pass

    while True:
        watch = [fd for fd in open_out if fd is not None] + [hup_r]
        if stdin_open:
            watch.append(in_fd)
        timeout = 0.1 if (hup_at is not None or exited_at is not None or status is None and pid is not None) else None
        ready, _, _ = select.select(watch, [], [], timeout)
        for fd in ready:
            if fd == hup_r:
                os.read(hup_r, CHUNK)
                hang_up()
            elif fd == in_fd:
                try:
                    chunk = os.read(in_fd, CHUNK)
                except BlockingIOError:
                    continue
                if not chunk:
                    stdin_open = False
                    hang_up()
                    continue
                for kind, payload in reader.feed(chunk):
                    if kind == b'S' and pid is None:
                        spec = json.loads(payload)
                        tty = spec.get('tty', True)
                        pid, fds = start(spec)
                        open_out[fds['out']] = b'O'
                        if fds['err'] is not None:
                            open_out[fds['err']] = b'X'
                    elif kind == b'D' and fds is not None and fds['in'] is not None:
                        try:
                            os.write(fds['in'], payload)
                        except OSError:
                            pass
                    elif kind == b'R' and fds is not None and tty:
                        size = json.loads(payload)
                        try:
                            winsize(fds['in'], int(size['cols']), int(size['rows']))
                        except OSError:
                            pass
                    elif kind == b'E' and fds is not None and fds['in'] is not None:
                        if tty:
                            os.write(fds['in'], b'\x04')
                        else:
                            os.close(fds['in'])
                            fds['in'] = None
                    elif kind == b'H':
                        hang_up()
            else:
                try:
                    chunk = os.read(fd, CHUNK)
                except OSError:
                    chunk = b''
                if chunk:
                    send(open_out[fd], chunk)
                else:
                    del open_out[fd]
        if pid is not None and status is None:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:
                status = st
                exited_at = time.monotonic()
        if hup_at is not None and status is None:
            # Again every half second: a hang-up right after start can land before the child's setsid,
            # or while SIGHUP is still ignored before its exec.
            late = time.monotonic() - hup_at
            sig = signal.SIGKILL if late > KILL_AFTER else signal.SIGHUP if late > (resent + 1) * 0.5 else None
            if sig is not None:
                resent += 1
                for kill in (os.killpg, os.kill):
                    try:
                        kill(pid, sig)
                    except ProcessLookupError:
                        pass
        # Output after exit: until every stream ends, or briefly when a background job keeps the PTY open.
        if status is not None and (not open_out or time.monotonic() - exited_at > DRAIN_AFTER_EXIT):
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
            sig = signal.Signals(os.WTERMSIG(status)).name if os.WIFSIGNALED(status) else None
            send(b'Z', json.dumps({'exitCode': code, 'signal': sig}).encode())
            return


if __name__ == '__main__':
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    main()
