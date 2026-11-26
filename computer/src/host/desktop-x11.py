#!/usr/bin/env python3
# The session's desktop (docs/design/session-browser-desktop.md): one X display
# in the session's container, served as VNC (RFB) on this process's stdin and
# stdout, which the host's terminal helper carries over one channel of the wire
# to the dashboard's noVNC.
#
# The host runs it as `exec python3 -I desktop-x11.py` (host/terminal.ts, `app:
# desktop`); the caller never chooses what runs.
#
# Invariants:
# - No port: x11vnc runs with -inetd on one end of a socket pair, this process
#   copies the other end to and from its stdio, and Xvfb runs with -nolisten
#   tcp. Only the wire, through the host, reaches the display's VNC.
# - The display (Xvfb :73, and openbox when the image has it) starts with the
#   first viewer, in its own session (setsid), and outlives it: apps started on
#   DISPLAY=:73 keep running and the next viewer sees them. It ends with the
#   session's container.
# - x11vnc dies with this process (PR_SET_PDEATHSIG), and this process ends on
#   stdin's end, x11vnc's end, or SIGHUP/SIGTERM (the terminal helper's
#   hang-up). The display does not.
# - Without Xvfb or x11vnc in the image, the viewer gets an RFB refusal with a
#   reason (no security types), which noVNC shows, and this exits 0.
# - Standard library only, run with -I: nothing in the workspace changes it.

import ctypes
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

DISPLAY_NUM = int(os.environ.get('OPC_DESKTOP_DISPLAY', '73'))
SIZE = os.environ.get('OPC_DESKTOP_SIZE', '1280x800')
DISPLAY = f':{DISPLAY_NUM}'
START_WAIT_S = 10


def refuse(reason):
    """An RFB 3.8 handshake that offers no security type, with the reason."""
    out = sys.stdout.buffer
    out.write(b'RFB 003.008\n')
    out.flush()
    sys.stdin.buffer.read(12)
    msg = reason.encode()
    out.write(b'\x00' + struct.pack('>I', len(msg)) + msg)
    out.flush()


def display_up():
    # Xvfb listens on the abstract socket too, where /tmp/.X11-unix is not writable (rootless).
    for addr in ('\0/tmp/.X11-unix/X%d' % DISPLAY_NUM, '/tmp/.X11-unix/X%d' % DISPLAY_NUM):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.connect(addr)
            return True
        except OSError:
            pass
        finally:
            s.close()
    return False


def logs():
    d = os.path.join(os.path.expanduser('~'), '.cache', 'opc-desktop')
    os.makedirs(d, exist_ok=True)
    return d


def detached(argv, log):
    """Starts `argv` in its own session, so a viewer's hang-up does not reach it."""
    with open(os.path.join(logs(), log), 'ab') as f:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=f, stderr=f, start_new_session=True,
                         env={**os.environ, 'DISPLAY': DISPLAY}, cwd=os.path.expanduser('~'))


def start_display():
    if display_up():
        return True
    # A lock left by a display that is gone (the container restarted) would stop Xvfb.
    lock = '/tmp/.X%d-lock' % DISPLAY_NUM
    try:
        os.kill(int(open(lock).read().strip()), 0)
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        try:
            os.unlink(lock)
        except OSError:
            pass
    detached(['Xvfb', DISPLAY, '-screen', '0', SIZE + 'x24', '-nolisten', 'tcp', '-dpi', '96'], 'xvfb.log')
    deadline = time.monotonic() + START_WAIT_S
    while time.monotonic() < deadline:
        if display_up():
            if shutil.which('openbox'):
                detached(['openbox'], 'openbox.log')
            return True
        time.sleep(0.05)
    return False


def die_with_parent():
    ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG


def copy(read, write, then):
    try:
        while True:
            b = read(65536)
            if not b:
                break
            write(b)
    except OSError:
        pass
    then()


def main():
    if not shutil.which('Xvfb') or not shutil.which('x11vnc'):
        refuse("This session's image has no desktop (it needs Xvfb and x11vnc).")
        return 0
    if not start_display():
        refuse('The display did not start; see ~/.cache/opc-desktop/xvfb.log in the session.')
        return 0
    ours, theirs = socket.socketpair()
    # -inetd: one client on fd 0, which it reads and writes. -q: no logs to the client. -nopw: the wire
    # authenticated the viewer.
    with open(os.path.join(logs(), 'x11vnc.log'), 'ab') as log:
        vnc = subprocess.Popen(
            ['x11vnc', '-inetd', '-q', '-nopw', '-display', DISPLAY, '-noxrecord', '-noxdamage', '-ncache', '0'],
            stdin=theirs, stdout=theirs, stderr=log, preexec_fn=die_with_parent, env={**os.environ, 'DISPLAY': DISPLAY})
    theirs.close()
    done = threading.Event()
    stdin, stdout = sys.stdin.buffer.raw, sys.stdout.buffer.raw

    def to_vnc_ended():
        try:
            ours.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        done.set()

    def write_out(b):
        view = memoryview(b)
        while view:
            n = stdout.write(view)
            view = view[n:]

    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, lambda *_: done.set())
    threading.Thread(target=copy, args=(stdin.read, ours.sendall, to_vnc_ended), daemon=True).start()
    threading.Thread(target=copy, args=(ours.recv, write_out, done.set), daemon=True).start()
    done.wait()
    vnc.terminate()
    try:
        vnc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        vnc.kill()
    return 0


if __name__ == '__main__':
    sys.exit(main())
