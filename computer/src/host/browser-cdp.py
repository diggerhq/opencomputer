#!/usr/bin/env python3
# A session's browser (docs/design/session-browser-desktop.md): headless
# Chromium in the session's container, driven over the DevTools protocol on
# `--remote-debugging-pipe`, its page streamed as JPEG frames. The host starts
# it as a terminal's command without a tty (host/terminal.ts, `app: browser`),
# so its stdin and stdout are the bytes of one relay channel:
#
#   in:  JSON lines   {"t":"viewport","width","height","dpr"}  {"t":"navigate","url"}
#                     {"t":"back"|"forward"|"reload"|"stop"}
#                     {"t":"mouse","type","x","y","button","buttons","clickCount","modifiers","deltaX","deltaY"}
#                     {"t":"key","type","key","code","text","keyCode","modifiers"}  {"t":"text","text"}
#   out: frame = type (1 byte) | length (u32 big-endian) | payload
#        J  JSON  {"t":"state","url","title","loading","canGoBack","canGoForward"}  {"t":"error","message"}
#        F  one JPEG screencast frame of the viewport
#
# Invariants:
# - Standard library only: it runs with the image's python3, from the release
#   mounted read-only at /opt/slack-presence.
# - Chromium listens on no port: DevTools is the pipe on fds 3 and 4, so
#   nothing else in the container (or outside) can drive it.
# - A frame is acknowledged only once it has been written to stdout, so a slow
#   viewer slows the screencast instead of growing a queue (the relay pauses
#   the socket while its WebSocket is congested, and the pipes fill); and no
#   sooner than 1/OPC_BROWSER_MAX_FPS (15) after the one before.
# - Chromium dies with this process (PR_SET_PDEATHSIG), and this process ends
#   on stdin's end or SIGHUP/SIGTERM (the terminal helper's hang-up).
# - One page: a page it opens (target=_blank, window.open) is loaded in the
#   page instead, and closed.
# - The profile lives in the session's home (~/.cache/opc-browser), so its
#   cookies outlast the tab; a second browser in the same session waits for
#   the first to let it go (the host allows one per session).

import base64
import ctypes
import fcntl
import glob
import json
import os
import shutil
import signal
import struct
import sys
import threading
import time

MAX_SIDE = 4096
MAX_FPS = float(os.environ.get('OPC_BROWSER_MAX_FPS') or 15)
QUALITY = int(os.environ.get('OPC_BROWSER_JPEG_QUALITY') or 70)
PROFILE = os.environ.get('OPC_BROWSER_PROFILE') or os.path.join(os.environ.get('HOME') or '/tmp', '.cache', 'opc-browser')
START_URL = os.environ.get('OPC_BROWSER_START_URL') or 'about:blank'

out_lock = threading.Lock()
out_fd = sys.stdout.fileno()


def emit(kind, payload):
    data = kind + struct.pack('>I', len(payload)) + payload
    with out_lock:
        view = memoryview(data)
        while view:
            view = view[os.write(out_fd, view):]


def emit_json(obj):
    emit(b'J', json.dumps(obj, separators=(',', ':')).encode())


def find_chromium():
    env = os.environ.get('OPC_BROWSER_BIN')
    if env:
        return env, False
    root = os.environ.get('PLAYWRIGHT_BROWSERS_PATH') or '/opt/ms-playwright'
    for pattern in ('chromium_headless_shell-*/chrome-*/chrome-headless-shell', 'chromium_headless_shell-*/chrome-*/headless_shell'):
        found = sorted(glob.glob(os.path.join(root, pattern)))
        if found:
            return found[-1], False
    for pattern in ('chromium-*/chrome-linux*/chrome',):
        found = sorted(glob.glob(os.path.join(root, pattern)))
        if found:
            return found[-1], True
    for name in ('chromium', 'chromium-browser', 'google-chrome'):
        path = shutil.which(name)
        if path:
            return path, True
    return None, False


def spawn_chromium(binary, full, width, height):
    # Chromium reads commands on fd 3 and writes answers on fd 4 (NUL-terminated JSON).
    to_r, to_w = os.pipe()
    from_r, from_w = os.pipe()
    os.makedirs(PROFILE, exist_ok=True)
    argv = [
        binary, '--remote-debugging-pipe', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
        '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update',
        '--disable-features=Translate,MediaRouter', '--mute-audio', '--password-store=basic',
        f'--user-data-dir={PROFILE}', f'--window-size={width},{height}',
    ]
    if full:
        argv.append('--headless=new')
    argv.append('about:blank')
    pid = os.fork()
    if pid == 0:
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            libc.prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG
            hi_r = fcntl.fcntl(to_r, fcntl.F_DUPFD, 10)
            hi_w = fcntl.fcntl(from_w, fcntl.F_DUPFD, 10)
            os.dup2(hi_r, 3)
            os.dup2(hi_w, 4)
            null = os.open(os.devnull, os.O_RDWR)
            os.dup2(null, 0)
            os.dup2(null, 1)
            os.dup2(null if not os.environ.get('OPC_BROWSER_DEBUG') else 2, 2)
            os.closerange(5, 1024)
            signal.signal(signal.SIGHUP, signal.SIG_DFL)
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            os.execv(binary, argv)
        finally:
            os._exit(127)
    os.close(to_r)
    os.close(from_w)
    return pid, to_w, from_r


class Cdp:
    """The browser's DevTools pipe: calls by id, events to `on_event`."""

    def __init__(self, w, r, on_event):
        self.w, self.r, self.on_event = w, r, on_event
        self.next_id = 1
        self.waiting = {}
        self.lock = threading.Lock()
        self.closed = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def send(self, method, params=None, session=None, wait=False, timeout=15):
        with self.lock:
            msg_id = self.next_id
            self.next_id += 1
            slot = None
            if wait:
                slot = self.waiting[msg_id] = [threading.Event(), None]
            msg = {'id': msg_id, 'method': method, 'params': params or {}}
            if session:
                msg['sessionId'] = session
            data = json.dumps(msg).encode() + b'\0'
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(self.w, view):]
            except OSError:
                self.closed.set()
        if slot is None:
            return None
        if not slot[0].wait(timeout) or slot[1] is None:
            raise RuntimeError(f'{method}: no answer')
        if 'error' in slot[1]:
            raise RuntimeError(f"{method}: {slot[1]['error'].get('message')}")
        return slot[1].get('result') or {}

    def _read(self):
        buf = b''
        while True:
            try:
                chunk = os.read(self.r, 1 << 20)
            except OSError:
                chunk = b''
            if not chunk:
                break
            buf += chunk
            while True:
                end = buf.find(b'\0')
                if end < 0:
                    break
                raw, buf = buf[:end], buf[end + 1:]
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if 'id' in msg:
                    slot = self.waiting.pop(msg['id'], None)
                    if slot:
                        slot[1] = msg
                        slot[0].set()
                else:
                    try:
                        self.on_event(msg)
                    except Exception as e:  # an event this does not understand never ends the browser
                        print(f'browser: event {msg.get("method")}: {e}', file=sys.stderr)
        self.closed.set()
        for slot in list(self.waiting.values()):
            slot[0].set()


class Browser:
    def __init__(self):
        self.cdp = None
        self.target = None
        self.session = None
        self.popups = set()
        self.last_frame = 0.0
        self.size = {'width': 1280, 'height': 800, 'dpr': 1}
        self.state = {'url': '', 'title': '', 'loading': False, 'canGoBack': False, 'canGoForward': False}

    def start(self, binary, full):
        self.pid, w, r = spawn_chromium(binary, full, self.size['width'], self.size['height'])
        self.cdp = Cdp(w, r, self.event)
        self.cdp.send('Target.setDiscoverTargets', {'discover': True}, wait=True)
        pages = [t for t in self.cdp.send('Target.getTargets', wait=True)['targetInfos'] if t['type'] == 'page']
        self.target = pages[0]['targetId'] if pages else self.cdp.send('Target.createTarget', {'url': 'about:blank'}, wait=True)['targetId']
        self.session = self.cdp.send('Target.attachToTarget', {'targetId': self.target, 'flatten': True}, wait=True)['sessionId']
        page = lambda m, p=None: self.cdp.send(m, p, session=self.session, wait=True)  # noqa: E731
        page('Page.enable')
        page('Emulation.setFocusEmulationEnabled', {'enabled': True})
        self.apply_viewport()
        if START_URL != 'about:blank':
            self.navigate(START_URL)
        self.publish()

    def call(self, method, params=None):
        return self.cdp.send(method, params, session=self.session)

    def apply_viewport(self):
        s = self.size
        self.cdp.send('Emulation.setDeviceMetricsOverride', {'width': s['width'], 'height': s['height'], 'deviceScaleFactor': s['dpr'], 'mobile': False}, session=self.session, wait=True)
        self.cdp.send('Page.stopScreencast', session=self.session, wait=True)
        self.cdp.send('Page.startScreencast', {
            'format': 'jpeg', 'quality': QUALITY,
            'maxWidth': int(s['width'] * s['dpr']), 'maxHeight': int(s['height'] * s['dpr']), 'everyNthFrame': 1,
        }, session=self.session, wait=True)

    def navigate(self, url):
        url = url.strip()
        if not url:
            return
        if '://' not in url and not url.startswith(('about:', 'data:', 'chrome:')):
            local = url.split('/')[0].split(':')[0] in ('localhost', '127.0.0.1', '0.0.0.0', '[::1]')
            url = ('http://' if local else 'https://') + url
        r = self.cdp.send('Page.navigate', {'url': url}, session=self.session, wait=True)
        if r.get('errorText'):
            emit_json({'t': 'error', 'message': f"{url}: {r['errorText']}"})

    def history(self, step):
        h = self.cdp.send('Page.getNavigationHistory', session=self.session, wait=True)
        i = h['currentIndex'] + step
        if 0 <= i < len(h['entries']):
            self.call('Page.navigateToHistoryEntry', {'entryId': h['entries'][i]['id']})

    def publish(self):
        try:
            h = self.cdp.send('Page.getNavigationHistory', session=self.session, wait=True, timeout=5)
            self.state['canGoBack'] = h['currentIndex'] > 0
            self.state['canGoForward'] = h['currentIndex'] < len(h['entries']) - 1
        except RuntimeError:
            pass
        emit_json({'t': 'state', **self.state})

    def event(self, msg):
        method, p = msg.get('method'), msg.get('params') or {}
        if method == 'Page.screencastFrame':
            emit(b'F', base64.b64decode(p['data']))
            # The next frame comes after the ack: holding it caps the rate (and the CPU and bandwidth with it).
            wait = self.last_frame + 1 / MAX_FPS - time.monotonic()
            self.last_frame = time.monotonic() + max(0, wait)
            ack = lambda: self.call('Page.screencastFrameAck', {'sessionId': p['sessionId']})  # noqa: E731
            if wait > 0:
                threading.Timer(wait, ack).start()
            else:
                ack()
        elif method == 'Target.targetInfoChanged' or method == 'Target.targetCreated':
            info = p['targetInfo']
            if info['targetId'] == self.target:
                changed = info.get('url') != self.state['url'] or info.get('title') != self.state['title']
                self.state['url'], self.state['title'] = info.get('url', ''), info.get('title', '')
                if changed:
                    threading.Thread(target=self.publish, daemon=True).start()
            elif info['type'] == 'page' and self.target:
                self.popups.add(info['targetId'])
                if info.get('url') not in ('', 'about:blank'):
                    self.popups.discard(info['targetId'])
                    self.cdp.send('Target.closeTarget', {'targetId': info['targetId']})
                    self.call('Page.navigate', {'url': info['url']})
        elif method in ('Page.frameStartedLoading', 'Page.frameStoppedLoading') and msg.get('sessionId') == self.session:
            loading = method == 'Page.frameStartedLoading'
            if loading != self.state['loading']:
                self.state['loading'] = loading
                threading.Thread(target=self.publish, daemon=True).start()

    def handle(self, m):
        t = m.get('t')
        if t == 'viewport':
            self.size = {
                'width': max(100, min(MAX_SIDE, int(m.get('width') or 1280))),
                'height': max(100, min(MAX_SIDE, int(m.get('height') or 800))),
                'dpr': max(1, min(3, float(m.get('dpr') or 1))),
            }
            self.apply_viewport()
        elif t == 'navigate':
            self.navigate(str(m.get('url') or ''))
        elif t == 'back':
            self.history(-1)
        elif t == 'forward':
            self.history(1)
        elif t == 'reload':
            self.call('Page.reload')
        elif t == 'stop':
            self.call('Page.stopLoading')
        elif t == 'mouse':
            p = {k: m[k] for k in ('type', 'x', 'y', 'button', 'buttons', 'clickCount', 'modifiers', 'deltaX', 'deltaY') if k in m}
            self.call('Input.dispatchMouseEvent', p)
        elif t == 'key':
            p = {k: m[k] for k in ('type', 'key', 'code', 'text', 'modifiers') if k in m}
            if 'keyCode' in m:
                p['windowsVirtualKeyCode'] = p['nativeVirtualKeyCode'] = m['keyCode']
            self.call('Input.dispatchKeyEvent', p)
        elif t == 'text':
            self.call('Input.insertText', {'text': str(m.get('text') or '')})

    def stop(self):
        try:
            self.cdp.send('Browser.close')
        except Exception:
            pass
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if os.waitpid(self.pid, os.WNOHANG)[0]:
                return
            time.sleep(0.05)
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main():
    binary, full = find_chromium()
    if not binary:
        emit_json({'t': 'error', 'message': 'No Chromium in this session\'s image.'})
        return 2
    browser = Browser()
    try:
        browser.start(binary, full)
    except Exception as e:
        emit_json({'t': 'error', 'message': f'The browser could not start: {e}'})
        return 1
    done = threading.Event()
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, lambda *_: done.set())

    def read_input():
        for line in sys.stdin.buffer:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if isinstance(m, dict):
                try:
                    browser.handle(m)
                except Exception as e:
                    emit_json({'t': 'error', 'message': str(e)})
        done.set()

    threading.Thread(target=read_input, daemon=True).start()
    while not done.wait(0.5):
        if browser.cdp.closed.is_set():
            emit_json({'t': 'error', 'message': 'The browser exited.'})
            break
    browser.stop()
    return 0


if __name__ == '__main__':
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main())
