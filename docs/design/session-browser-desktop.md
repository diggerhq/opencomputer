# Browser and Virtual Desktop for sessions

Status: Browser and Desktop implemented, each behind its own flags (Browser in #1162, Desktop in the PR stacked on it).
Stacked on #1068 and #1101 (web terminal and the session sidebar).

## Goal

Someone watching a session in the dashboard can see and drive what the agent
builds: open the dev server the session runs on `localhost:3000`, click
through it, log in somewhere, look at a page the agent is scraping. Today the
sidebar has a Terminal; this adds a **Browser** tab and a
**Desktop** tab (a full X display).

Non-goals for now: letting the agent and the person share one browser (the
agent's own Playwright runs are separate), recording, multiple viewers of one
browser.

## Browser

### Shape

```
dashboard tab ──WebSocket (ticket, opc.v1)──▶ wire Worker ──▶ relay (computer/src/wire)
     ▲  JPEG frames, page state                                   │ binary channel frames
     │  JSON input lines                                          ▼
     └───────────────────────────────────────────── host wire-link ─▶ host Terminals
                                                                       │ podman exec (no tty)
                                                                       ▼
                                                    python3 -I browser-cdp.py  (in the session's container)
                                                                       │ --remote-debugging-pipe (fds 3/4)
                                                                       ▼
                                                    chromium-headless-shell (already in the image)
```

A browser **is a terminal without a tty whose command the host fixes**. The
host runs `exec python3 -I <release>/src/host/browser-cdp.py` inside the
session's container through the same `podman exec` path a terminal uses. The
client never names a command. Everything a terminal already has is reused
as-is: the access checks at the relay and again at the host, the unix socket per
stream, the 64 KiB channel frames, backpressure (a congested WebSocket pauses
the socket, the pipe fills, and the helper stops acking frames), hang-up on
disconnect, and the session counting as in use (no idle suspend while a
browser is open).

### Wire API

| | |
|---|---|
| `browsers.open {sessionId}` | `{browser: {id: br_…, channel}}`. Needs the `terminals` scope and a writable connection, like `terminals.open` |
| `browsers.close {browserId}` | ends it |
| `browser.exited {browserId, reason?}` | notification; `reason` is `idle` or `access_lost` when the relay hung it up |

Errors: `browser_unavailable` (409, the host does not run browsers),
`too_many_browsers` (409, one per session), plus the terminal ones
(`session_not_running`, `forbidden`/`terminal_owner_only`).

Host protocol: `terminal.open` gains `app?: 'browser'`. Host records log
`terminal.opened` with `app: 'browser'` and `command: null`.

### Channel protocol (browser-cdp.py)

In, JSON lines:

- `viewport {width, height, dpr}` (CSS px, dpr 1–3, sides 100–4096)
- `navigate {url}` (a scheme is added when missing: `http://` for localhost and IPs, `https://` otherwise)
- `back` / `forward` / `reload` / `stop`
- `mouse {type, x, y, button, buttons, clickCount, modifiers, deltaX, deltaY}` (`Input.dispatchMouseEvent`)
- `key {type, key, code, text, keyCode, modifiers}` (`Input.dispatchKeyEvent`)
- `text {text}` (paste, `Input.insertText`)

Out, records `type (1 byte) | length (u32 BE) | payload`:

- `J` JSON: `{t: "state", url, title, loading, canGoBack, canGoForward}` or `{t: "error", message}`
- `F` one JPEG frame of the viewport (`Page.startScreencast`, quality 70)

The relay cuts the stream into ≤ 64 KiB WebSocket frames, so the client
reassembles records across frames (`web/…/browser-wire.ts` `records`).

### The helper

`computer/src/host/browser-cdp.py` uses only the standard library, so it runs
with the image's python3 from the release mounted read-only at
`/opt/slack-presence`. It:

- starts `chromium-headless-shell` (falling back to full Chromium with `--headless=new`) with `--remote-debugging-pipe`. **DevTools listens on no port**: nothing else in the container can drive it;
- ties Chromium's life to its own (`PR_SET_PDEATHSIG`) and exits on stdin EOF, SIGHUP or SIGTERM (the terminal helper's hang-up);
- acks a screencast frame only once it is written to stdout, and no sooner than 1/15 s after the previous one (`OPC_BROWSER_MAX_FPS`). A slow viewer slows the screencast instead of growing a queue;
- keeps one page: popups (`target=_blank`, `window.open`) load in the page and are closed;
- keeps its profile at `~/.cache/opc-browser` in the session's home, so logins outlive the tab.

### Dashboard

`SessionBrowser.tsx` renders frames to a canvas (newest frame wins while one
decodes), lays the page out at the tab's size (it sends `viewport` on resize,
debounced), and maps pointer, wheel, keys and paste to input lines. It has a
URL bar with back, forward and reload/stop. Copying out of the page into the
local clipboard is not wired (follow-up: `Runtime.evaluate` on the selection).
The tab reuses the terminal ticket (`POST /tickets {terminal: true}`).

### Switches

Two flags, both default off:

| Where | Flag | Effect |
|---|---|---|
| Host | `SP_SESSION_BROWSER=1` | **enforcement**: without it `browsers.open` answers `browser_unavailable` |
| Capabilities | `features.browser: true` | **visibility**: the dashboard shows the tab only then. Optional in the schema; the computer's static capabilities leave it out (a release cannot know its host's flag), so the service that serves `/capabilities` sets it. Wiring an env flag there (e.g. `COMPUTER_BROWSER=1`) is a small follow-up in `services/managed-agents` |

Per-workspace opt-in would be a third, later step (the capability per
organization, and the host gate per session from the workspace definition).

### Limits, reused

- **Viewer cap:** one browser per session (`BROWSERS_PER_SESSION`), on top of the 8 terminals. A second tab gets `too_many_browsers`. A shared broker (one Chromium, frames fanned out to N viewers, input from the driver only) is the follow-up if people ask to watch together.
- **Idle:** the terminal idle timeout (`SP_WIRE_TERMINAL_IDLE_MINUTES`, 15 min) counting **input only**, since a page animates by itself. Then `browser.exited {reason: "idle"}`.
- **Access lost:** same as terminals. When the member may no longer drive the session, the browser is closed with `reason: "access_lost"`.
- **Lazy start, teardown:** nothing runs until the tab is opened. Closing the tab, the sidebar's WebSocket, or the session hangs up the helper, and Chromium dies with it. Verified end to end: no process is left after the dashboard disconnects. Switching tabs or closing the sidebar only hides the tab, as with Terminal.

### Measured (session image `computer-session:4caeaa0f…`, 1280×800, dpr 1)

CPU is % of one core and includes page rendering. PSS is the sum over Chromium's processes and the helper.

| Page | Uncapped CPU | Uncapped fps, bytes | 15 fps cap CPU | Capped fps, bytes | PSS |
|---|---|---|---|---|---|
| about:blank | – | – | 0.1% | 0 | 182 MiB |
| example.com (static) | – | – | 0.1% | 0 | 215 MiB |
| Wikipedia article (scrolling) | 58% | 42.7 fps, 5 MB/s | 29.5% | 11.8 fps, 1.4 MB/s | 276 MiB |
| CSS animation | 68.5% | 60 fps | 35.4% | 15 fps, 211 KiB/s | 220 MiB |

- First frame 0.33 s after `browsers.open`'s helper starts; exit 0.16 s after stdin closes.
- **Image: +0 MB.** Playwright's Chromium (403 MB), chromium-headless-shell (273 MB), its libraries and python3 are already in the image.
- A static page costs nothing after it renders: the screencast sends frames only on change.

### Security

- No new ports. Chromium uses a pipe, not `--remote-debugging-port`. The helper's stdio is the only way in, and it is reached only through the existing authenticated wire (ticket, edge signature, `terminals` scope, drive permission checked at the relay and at the host).
- Runs in the session's rootless container as the session's user, with the session's network, so it sees the same `localhost` the agent does and nothing more. `--no-sandbox` is needed because Chromium's sandbox cannot nest in the rootless container; the container is the boundary, as it is for everything else the session runs.
- The client picks no command, so `browsers.open` cannot run anything a terminal could not. It is in fact narrower, since the person may already open a shell.
- Frames contain whatever the page shows, so they are treated like terminal output: not logged or recorded, and gone with the connection.

### Tests

- Host (`host/terminal.test.ts`): the gate; the fixed command (a caller's `command` is ignored); one browser per session, apart from the 8 terminals; quoting.
- Relay (`wire/terminal.test.ts`): `browsers.open` → host `terminal.open {app: 'browser', tty: false}` with no command; excess params refused; one channel both ways; `browsers.close`/`browser.exited`; terminals and browsers are not interchangeable; idle counts input only; scope, read-only and access checks.
- Web: `browser-wire.test.ts` (record reassembly across frames, the open/exit/refusal flow, key mapping) and `SessionSidebar.test.tsx` (the tab only with `features.browser`).
- End to end, local: the dashboard (preview build, `VITE_PREVIEW_WIRE_URL`) → a stand-in for the wire Worker that signs edge headers → **the real relay** → a fake host link answering with **the real host `Terminals`** → **real `terminal-pty.py` → `browser-cdp.py` → headless Chromium** (local Playwright build) → a dev server on `localhost:3000`. Navigation, history, clicks, typing, Enter, wheel scroll and teardown were all checked. The measurements above ran the helper in the real session image. Not covered end to end: `podman exec` into a live session container on a hosted computer, and the managed-agents Worker.

## Desktop

A full X desktop for apps that are not a browser page (Electron, a native GUI,
a headed Playwright run the person wants to watch).

### Shape

The browser's pattern again: `desktops.open` is a terminal without a tty whose
host-fixed command is `exec python3 -I host/desktop-vnc.py`, so it gets the
terminal's access checks, socket, backpressure, hang-up and idle exemption.
Ids are `dk_…`; one desktop per session (`too_many_desktops`), apart from the
8 terminals and the browser.

`desktop-vnc.py`, in the session's container:

- The display is **TigerVNC's Xvnc** `:73`: X server and VNC server in one, started on the first open in its own session (`setsid`), with `openbox` and a first small `xterm` when the image has them. It listens on **no TCP port** (`-nolisten tcp`, `-rfbport -1`); VNC is on a 0600 unix socket in `~/.cache/opc-desktop`, with security type None (the wire authenticated the viewer).
- Each viewer: the helper connects to that socket and copies it to and from its stdio. It ends on stdin's end, the socket's end, or the hang-up's SIGHUP/SIGTERM. The display **outlives the viewer**: apps on `DISPLAY=:73` keep running and the next open shows them. It ends with the container. A stale `/tmp/.X73-lock` is cleared; readiness is checked on the abstract X socket, since a rootless container cannot create `/tmp/.X11-unix`.
- **The display follows the pane.** Xvnc accepts the viewer's SetDesktopSize (`-AcceptSetDesktopSize`), and noVNC (`resizeSession`) sends one on connect and on every resize of the pane, rate-limited. So the desktop is the tab's size, not letterboxed, and dragging the sidebar edge resizes it within ~0.1 s. `scaleViewport` stays on as the fallback.
- **Wallpaper:** the dashboard's dark grey (`#1a1917`) with the OpenComputer mark and wordmark centred (`deploy/image/desktop-wallpaper.png`, 9 KB, rendered from the dashboard's `OpenComputerMark`), drawn by `hsetroot`. The root background is a picture of one size, so the helper reads the screen size from the X connection setup once a second while a viewer is connected and draws it again when the size changes.
- Without Xvnc in the image, it answers with an RFB 3.8 refusal (no security types, with a reason), which the tab shows: the current production image degrades to a message, not a hang.

Xvfb plus `x11vnc -inetd` was the first version. It was replaced because Xvfb cannot change its size at runtime (RandR is fixed at the starting size and it rejects new modes), and x11vnc does not accept SetDesktopSize, so the display could only be scaled into the pane, which letterboxed it.

`OPC_DESKTOP_DISPLAY` and `OPC_DESKTOP_SIZE` override `:73` and `1280x800`.
The agent can start GUI apps with `DISPLAY=:73`; telling it so (env or system
prompt) is a follow-up.

**Idle.** A VNC viewer sends FramebufferUpdateRequests continuously, so "any
input" would keep a desktop alive forever. For desktops the relay
(`wire/rfb-input.ts`) parses the client's RFB stream and counts only key,
pointer, cut-text and QEMU key events as activity, and follows what noVNC sends
TigerVNC besides (fences, continuous updates, SetDesktopSize, the extended
clipboard's negative lengths); the 15-minute idle close then works as for
terminals.

**Dashboard.** The Desktop tab (`SessionDesktop.tsx`, lazy, 58 KB gzipped) runs
noVNC 1.7.0's `RFB` over `RfbChannel` (`desktop-wire.ts`), an object with the
WebSocket interface noVNC accepts in place of a URL, whose bytes are channel
frames. No websockify. The session is resized to the tab (above). Dialling, wake and refusals are shared with the Browser
(`app-wire.ts`).

**Switches.** Host `SP_SESSION_DESKTOP=1` (enforcement, default off;
`desktop_unavailable` otherwise) and capability `features.desktop` (the tab's
visibility). `desktops.*` reuse the `terminals` scope.

**Image.** `deploy/image/Containerfile` adds `tigervnc-standalone-server
openbox hsetroot xterm` and the wallpaper PNG. CI builds it only as the test computers'
`:branch-…` image; production images are unchanged until released.

### Measured

- Image: **+69.5 MB** for `tigervnc-standalone-server openbox hsetroot xterm` plus the 9 KB wallpaper, on top of the current image (3.78 → 3.85 GB; the x11vnc version was +75.6 MB).
- With one viewer connected, idle: Xvnc + openbox + xterm **21 + 15 + 8 ≈ 44 MiB PSS**, CPU ~0, 0 KiB/s.
- With the xterm running `top -d 1`: CPU **< 0.5%** in total, **76 KiB/s** to the viewer (Tight/ZRLE; the x11vnc raw stream was ~1 MB/s).
- Dashboard end to end (below): tab click to a drawn desktop at the pane's size (559×866) **0.9–1.0 s**, display started cold; resizing the sidebar to 319 and 895 px wide refits it in **~0.1 s** after the drag.
- A headed full Chromium on the display, about:blank: **511 MiB PSS**, against 182 MiB for the headless shell. That is the cost of the Desktop showing "the browser".

### Limits

One viewer per desktop for now. Xvnc runs `-AlwaysShared`, so 2–3 viewers of
one display (input from the driver only) is a host cap away; that is an open
question below.

### Tests

- Computer: `host/terminal.test.ts` (gate off, `dk_` ids, one per session alongside a browser, output starts `RFB 003.008`, the caller's command never runs), `wire/rfb-input.test.ts` (which RFB messages count as input, split across frames, and the messages noVNC sends a TigerVNC server), `wire/terminal.test.ts` (open/close, not interchangeable with browsers, pointer events keep a desktop alive while update requests alone let it idle out).
- Web: `desktop-wire.test.ts` (the channel adapter, early bytes, close both ways) and the sidebar registry test.
- End to end, local: the same rig as the Browser, with the relay and host `Terminals` running **inside the image built from this Containerfile** → **real `desktop-vnc.py` → Xvnc, openbox, xterm, hsetroot** → noVNC in the preview dashboard. The desktop opened at the pane's size with the wallpaper and the first xterm, a click and typed text reached the xterm, and dragging the sidebar narrower and wider resized the X display to match, the wallpaper re-centred. Not covered: a hosted computer and the managed-agents Worker.

### Open question: one display or two?

The Browser could render into the Desktop's display (headed, `DISPLAY=:N`)
instead of headless. Then the person sees the same window in both tabs, and
the agent's own headed runs show up too. The cost is +330 MiB per open
browser (headed against headless) and coupling the tabs' lifetimes. The
two are separate for now (the Browser stays headless and cheap); this is
open.

## Open questions

1. Default: off everywhere, on for internal organizations first?
2. Image: the Browser needs nothing new. Should the Desktop's +76 MB go in the main session image or in a variant?
3. Viewer cap: one browser and one desktop viewer per session now. Is a shared multi-viewer broker (Xvnc already runs `-AlwaysShared`) wanted?
4. Should the Desktop share the Browser's display (above)?
5. Scope: browsers and desktops reuse the `terminals` scope, so existing terminal tickets work. Are separate scopes wanted?
