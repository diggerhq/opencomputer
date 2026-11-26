#!/usr/bin/env python3
# The session's desktop (docs/design/session-browser-desktop.md): one X display
# in the session's container, served as VNC (RFB) on this process's stdin and
# stdout, which the host's terminal helper carries over one channel of the wire
# to the dashboard's noVNC.
#
# The host runs it as `exec python3 -I desktop-vnc.py` (host/terminal.ts, `app:
# desktop`); the caller never chooses what runs.
#
# Invariants:
# - The display is TigerVNC's Xvnc :73, X server and VNC server in one. It
#   listens on no TCP port (X: -nolisten tcp; VNC: -rfbport -1) and serves VNC
#   on a 0600 unix socket in ~/.cache/opc-desktop, which this process copies to
#   and from its stdio. Only the wire, through the host, reaches it.
# - Xvnc accepts the viewer's SetDesktopSize, so the display follows the size
#   of the dashboard's pane. The wallpaper (the dark grey of the dashboard with
#   the OpenComputer mark centred) is drawn again whenever the size changes.
# - The display (Xvnc, openbox and a first xterm, when the image has them)
#   starts with the first viewer, in its own session (setsid), and outlives
#   it: apps started on DISPLAY=:73 keep running and the next viewer sees
#   them. It ends with the session's container.
# - This process ends on stdin's end, the display's end of the socket, or
#   SIGHUP/SIGTERM (the terminal helper's hang-up). The display does not.
# - Without Xvnc in the image, the viewer gets an RFB refusal with a reason
#   (no security types), which noVNC shows, and this exits 0.
# - Standard library only, run with -I: nothing in the workspace changes it.

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
WALLPAPER = os.environ.get('OPC_DESKTOP_WALLPAPER', '/usr/share/opc-desktop/wallpaper.png')
BACKGROUND = '#1a1917'
DISPLAY = f':{DISPLAY_NUM}'
START_WAIT_S = 10
WALLPAPER_POLL_S = 1


def refuse(reason):
    """An RFB 3.8 handshake that offers no security type, with the reason."""
    out = sys.stdout.buffer
    out.write(b'RFB 003.008\n')
    out.flush()
    sys.stdin.buffer.read(12)
    msg = reason.encode()
    out.write(b'\x00' + struct.pack('>I', len(msg)) + msg)
    out.flush()


def logs():
    d = os.path.join(os.path.expanduser('~'), '.cache', 'opc-desktop')
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def vnc_socket():
    return os.path.join(logs(), f'vnc-{DISPLAY_NUM}.sock')


def x_connect():
    # Xvnc listens on the abstract socket too, where /tmp/.X11-unix is not writable (rootless).
    for addr in ('\0/tmp/.X11-unix/X%d' % DISPLAY_NUM, '/tmp/.X11-unix/X%d' % DISPLAY_NUM):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.settimeout(2)
            s.connect(addr)
            return s
        except OSError:
            s.close()
    return None


def screen_size():
    """The display's size, from the X connection setup; None when it is not up."""
    s = x_connect()
    if not s:
        return None
    try:
        s.sendall(b'l\0\x0b\0\0\0\0\0\0\0\0\0')
        d = b''
        while len(d) < 8:
            b = s.recv(65536)
            if not b:
                return None
            d += b
        if d[0] != 1:
            return None
        n = 8 + 4 * struct.unpack('<H', d[6:8])[0]
        while len(d) < n:
            b = s.recv(65536)
            if not b:
                return None
            d += b
        vendor = struct.unpack('<H', d[24:26])[0]
        at = 40 + ((vendor + 3) & ~3) + 8 * d[29] + 20
        return struct.unpack('<HH', d[at:at + 4])
    except (OSError, struct.error, IndexError):
        return None
    finally:
        s.close()


def vnc_connect():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(vnc_socket())
        return s
    except OSError:
        s.close()
        return None


def detached(argv, log):
    """Starts `argv` in its own session, so a viewer's hang-up does not reach it."""
    with open(os.path.join(logs(), log), 'ab') as f:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=f, stderr=f, start_new_session=True,
                         env={**os.environ, 'DISPLAY': DISPLAY}, cwd=os.path.expanduser('~'))


def wallpaper():
    if not shutil.which('hsetroot'):
        return
    argv = ['hsetroot', '-solid', BACKGROUND]
    if os.path.exists(WALLPAPER):
        argv += ['-center', WALLPAPER]
    subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   env={**os.environ, 'DISPLAY': DISPLAY}, timeout=10, check=False)


def start_display():
    """Connects to the display's VNC, starting the display first if it is not up."""
    s = vnc_connect()
    if s:
        return s
    # A lock left by a display that is gone (the container restarted) would stop Xvnc.
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
    try:
        os.unlink(vnc_socket())
    except OSError:
        pass
    detached(['Xvnc', DISPLAY, '-geometry', SIZE, '-depth', '24', '-dpi', '96', '-desktop', 'OpenComputer',
              '-nolisten', 'tcp', '-rfbport', '-1', '-rfbunixpath', vnc_socket(), '-rfbunixmode', '0600',
              '-SecurityTypes', 'None', '-AlwaysShared', '-AcceptSetDesktopSize'], 'xvnc.log')
    deadline = time.monotonic() + START_WAIT_S
    while time.monotonic() < deadline:
        s = vnc_connect()
        if s and screen_size():
            wallpaper()
            if shutil.which('openbox'):
                detached(['openbox'], 'openbox.log')
            if shutil.which('xterm'):
                detached(['xterm', '-geometry', '72x14+16+16', '-fa', 'Monospace', '-fs', '11', '-bg', '#161513', '-fg', '#e6e1d8'], 'xterm.log')
            return s
        if s:
            s.close()
        time.sleep(0.05)
    return None


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
    if not shutil.which('Xvnc'):
        refuse("This session's image has no desktop (it needs TigerVNC's Xvnc).")
        return 0
    vnc = start_display()
    if not vnc:
        refuse('The display did not start; see ~/.cache/opc-desktop/xvnc.log in the session.')
        return 0
    done = threading.Event()
    stdin, stdout = sys.stdin.buffer.raw, sys.stdout.buffer.raw

    def to_vnc_ended():
        try:
            vnc.shutdown(socket.SHUT_WR)
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
    threading.Thread(target=copy, args=(stdin.read, vnc.sendall, to_vnc_ended), daemon=True).start()
    threading.Thread(target=copy, args=(vnc.recv, write_out, done.set), daemon=True).start()
    # The root's background is a picture of one size: centre it again when the viewer resizes the display.
    size = screen_size()
    while not done.wait(WALLPAPER_POLL_S):
        now = screen_size()
        if now and now != size:
            size = now
            wallpaper()
    vnc.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
