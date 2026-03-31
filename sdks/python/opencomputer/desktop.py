"""Desktop sandbox with remote display streaming, screenshots, and input control.

Uses Xvfb + x11vnc + noVNC inside the VM. The desktop environment (Xvfb + openbox)
is auto-started at sandbox creation. VNC streaming is started on-demand via stream.start().

Example::

    from opencomputer.desktop import Desktop

    desktop = await Desktop.create()
    await desktop.stream.start()
    print(desktop.stream.get_url())

    # Take a screenshot for AI agent
    png = await desktop.screenshot()

    # Programmatic input
    await desktop.left_click(500, 300)
    await desktop.write("hello world")
    await desktop.press("enter")

    await desktop.stream.stop()
    await desktop.kill()
"""

from __future__ import annotations

import re
import secrets
import string
from shlex import quote as shell_quote
from typing import Literal

from opencomputer.sandbox import Sandbox

MOUSE_BUTTONS = {"left": 1, "right": 3, "middle": 2}

KEYS: dict[str, str] = {
    "alt": "Alt_L",
    "backspace": "BackSpace",
    "caps_lock": "Caps_Lock",
    "ctrl": "Control_L",
    "control": "Control_L",
    "del": "Delete",
    "delete": "Delete",
    "down": "Down",
    "end": "End",
    "enter": "Return",
    "esc": "Escape",
    "escape": "Escape",
    "f1": "F1", "f2": "F2", "f3": "F3", "f4": "F4", "f5": "F5", "f6": "F6",
    "f7": "F7", "f8": "F8", "f9": "F9", "f10": "F10", "f11": "F11", "f12": "F12",
    "home": "Home",
    "insert": "Insert",
    "left": "Left",
    "page_down": "Page_Down",
    "page_up": "Page_Up",
    "right": "Right",
    "shift": "Shift_L",
    "space": "space",
    "super": "Super_L",
    "tab": "Tab",
    "up": "Up",
}


def _map_key(key: str) -> str:
    return KEYS.get(key.lower(), key.lower())


def _random_string(length: int = 16) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


DISPLAY = ":99"


class VNCStream:
    """On-demand VNC streaming via x11vnc + noVNC."""

    def __init__(self, desktop: Desktop) -> None:
        self._desktop = desktop
        self._vnc_port = 5900
        self._port = 6080
        self._password: str | None = None
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    def get_auth_key(self) -> str:
        """Get the auto-generated authentication key (only if require_auth was set)."""
        if not self._password:
            raise RuntimeError("No auth key — stream was started without require_auth")
        return self._password

    def get_url(
        self,
        auto_connect: bool = True,
        view_only: bool = False,
        resize: str = "scale",
        auth_key: str | None = None,
    ) -> str:
        """Get the noVNC URL for viewing the remote desktop in a browser."""
        # Build URL from sandbox's preview domain
        hostname = f"{self._desktop.sandbox_id}-p{self._port}.{self._desktop._sandbox_domain}"
        base = f"https://{hostname}/vnc.html"
        params = []
        if auto_connect:
            params.append("autoconnect=true")
        if view_only:
            params.append("view_only=true")
        if resize:
            params.append(f"resize={resize}")
        if auth_key:
            params.append(f"password={auth_key}")
        return f"{base}?{'&'.join(params)}" if params else base

    async def start(
        self,
        vnc_port: int | None = None,
        port: int | None = None,
        require_auth: bool = False,
        window_id: str | None = None,
    ) -> None:
        """Start VNC streaming. Launches x11vnc + noVNC inside the VM."""
        if self._running:
            raise RuntimeError("Stream is already running")

        self._vnc_port = vnc_port or self._vnc_port
        self._port = port or self._port
        self._password = _random_string() if require_auth else None

        args: list[str] = []
        if self._password:
            args.extend(["--password", self._password])
        if vnc_port:
            args.extend(["--vnc-port", str(vnc_port)])
        if port:
            args.extend(["--novnc-port", str(port)])
        if window_id:
            args.extend(["--window-id", window_id])

        await self._desktop.exec.run(
            f"/usr/local/bin/start-vnc {' '.join(args)}",
            timeout=15,
            env={"DISPLAY": DISPLAY},
        )

        # Verify noVNC is listening
        check = await self._desktop.exec.run(
            f'for i in $(seq 1 20); do netstat -tuln 2>/dev/null | grep -q ":{self._port} " && echo ready && exit 0; sleep 0.5; done; echo timeout',
            timeout=15,
        )
        if "ready" not in check.stdout:
            raise TimeoutError("noVNC failed to start")

        self._running = True

    async def stop(self) -> None:
        """Stop VNC streaming."""
        await self._desktop.exec.run("/usr/local/bin/stop-vnc", env={"DISPLAY": DISPLAY})
        self._running = False


class Desktop(Sandbox):
    """Desktop sandbox with display streaming and programmatic input control."""

    display: str = DISPLAY
    _sandbox_domain: str = ""

    @classmethod
    async def create(
        cls,
        template: str = "desktop",
        timeout: int = 300,
        api_key: str | None = None,
        api_url: str | None = None,
        envs: dict[str, str] | None = None,
        resolution: tuple[int, int] | None = None,
        dpi: int | None = None,
        **kwargs,
    ) -> Desktop:
        """Create a new desktop sandbox with a running display server.

        Args:
            template: Template to use (default "desktop").
            timeout: Sandbox timeout in seconds.
            api_key: API key (or OPENCOMPUTER_API_KEY env var).
            api_url: API URL (or OPENCOMPUTER_API_URL env var).
            envs: Extra environment variables.
            resolution: Screen resolution (width, height). Default (1024, 768).
            dpi: Display DPI. Default 96.
        """
        merged_envs = {"DISPLAY": DISPLAY}
        if envs:
            merged_envs.update(envs)

        sandbox = await Sandbox.create(
            template=template,
            timeout=timeout,
            api_key=api_key,
            api_url=api_url,
            envs=merged_envs,
            **kwargs,
        )

        # "Upgrade" the Sandbox instance to a Desktop
        desktop = cls.__new__(cls)
        desktop.__dict__.update(sandbox.__dict__)
        desktop.display = DISPLAY
        desktop.stream = VNCStream(desktop)

        return desktop

    @classmethod
    async def connect(
        cls,
        sandbox_id: str,
        api_key: str | None = None,
        api_url: str | None = None,
    ) -> Desktop:
        """Connect to an existing desktop sandbox."""
        sandbox = await Sandbox.connect(sandbox_id, api_key=api_key, api_url=api_url)
        desktop = cls.__new__(cls)
        desktop.__dict__.update(sandbox.__dict__)
        desktop.display = DISPLAY
        desktop.stream = VNCStream(desktop)
        return desktop

    async def screenshot(self) -> bytes:
        """Take a screenshot and return it as PNG bytes."""
        path = f"/tmp/screenshot-{_random_string(8)}.png"
        await self.exec.run(f"scrot --pointer {path}", env={"DISPLAY": DISPLAY})
        content = await self.files.read(path)
        await self.exec.run(f"rm -f {path}")
        return content if isinstance(content, bytes) else content.encode("latin-1")

    async def move_mouse(self, x: int, y: int) -> None:
        """Move the mouse to (x, y)."""
        await self.exec.run(f"xdotool mousemove --sync {x} {y}", env={"DISPLAY": DISPLAY})

    async def left_click(self, x: int | None = None, y: int | None = None) -> None:
        """Left click at the current position, or at (x, y) if provided."""
        if x is not None and y is not None:
            await self.move_mouse(x, y)
        await self.exec.run("xdotool click 1", env={"DISPLAY": DISPLAY})

    async def double_click(self, x: int | None = None, y: int | None = None) -> None:
        """Double left click."""
        if x is not None and y is not None:
            await self.move_mouse(x, y)
        await self.exec.run("xdotool click --repeat 2 1", env={"DISPLAY": DISPLAY})

    async def right_click(self, x: int | None = None, y: int | None = None) -> None:
        """Right click."""
        if x is not None and y is not None:
            await self.move_mouse(x, y)
        await self.exec.run("xdotool click 3", env={"DISPLAY": DISPLAY})

    async def middle_click(self, x: int | None = None, y: int | None = None) -> None:
        """Middle click."""
        if x is not None and y is not None:
            await self.move_mouse(x, y)
        await self.exec.run("xdotool click 2", env={"DISPLAY": DISPLAY})

    async def scroll(self, direction: Literal["up", "down"] = "down", amount: int = 1) -> None:
        """Scroll the mouse wheel."""
        button = "4" if direction == "up" else "5"
        await self.exec.run(f"xdotool click --repeat {amount} {button}", env={"DISPLAY": DISPLAY})

    async def mouse_press(self, button: Literal["left", "right", "middle"] = "left") -> None:
        """Press and hold a mouse button."""
        await self.exec.run(f"xdotool mousedown {MOUSE_BUTTONS[button]}", env={"DISPLAY": DISPLAY})

    async def mouse_release(self, button: Literal["left", "right", "middle"] = "left") -> None:
        """Release a mouse button."""
        await self.exec.run(f"xdotool mouseup {MOUSE_BUTTONS[button]}", env={"DISPLAY": DISPLAY})

    async def drag(self, fr: tuple[int, int], to: tuple[int, int]) -> None:
        """Drag from one position to another."""
        await self.move_mouse(fr[0], fr[1])
        await self.mouse_press()
        await self.move_mouse(to[0], to[1])
        await self.mouse_release()

    async def get_cursor_position(self) -> tuple[int, int]:
        """Get the current cursor position as (x, y)."""
        result = await self.exec.run("xdotool getmouselocation", env={"DISPLAY": DISPLAY})
        match = re.search(r"x:(\d+)\s+y:(\d+)", result.stdout)
        if not match:
            raise RuntimeError(f"Failed to parse cursor position: {result.stdout}")
        return int(match.group(1)), int(match.group(2))

    async def get_screen_size(self) -> tuple[int, int]:
        """Get the screen resolution as (width, height)."""
        result = await self.exec.run("xrandr", env={"DISPLAY": DISPLAY})
        match = re.search(r"(\d+)x(\d+)", result.stdout)
        if not match:
            raise RuntimeError(f"Failed to parse screen size: {result.stdout}")
        return int(match.group(1)), int(match.group(2))

    async def write(self, text: str, *, chunk_size: int = 25, delay_ms: int = 75) -> None:
        """Type text at the current cursor position.

        Args:
            text: Text to type.
            chunk_size: Characters per xdotool call.
            delay_ms: Delay between keystrokes in milliseconds.
        """
        for i in range(0, len(text), chunk_size):
            chunk = text[i : i + chunk_size]
            await self.exec.run(
                f"xdotool type --delay {delay_ms} -- {shell_quote(chunk)}",
                env={"DISPLAY": DISPLAY},
            )

    async def press(self, key: str | list[str]) -> None:
        """Press a key or key combination.

        Args:
            key: Key name (e.g. "enter") or list for combos (e.g. ["ctrl", "c"]).
        """
        if isinstance(key, list):
            mapped = "+".join(_map_key(k) for k in key)
        else:
            mapped = _map_key(key)
        await self.exec.run(f"xdotool key {mapped}", env={"DISPLAY": DISPLAY})

    async def open(self, file_or_url: str) -> None:
        """Open a file or URL in the default application."""
        await self.exec.run(f"xdg-open {shell_quote(file_or_url)}", env={"DISPLAY": DISPLAY})

    async def launch(self, application: str, uri: str | None = None) -> None:
        """Launch a .desktop application by name."""
        await self.exec.run(
            f"gtk-launch {application} {uri or ''}",
            env={"DISPLAY": DISPLAY},
        )

    async def get_current_window_id(self) -> str:
        """Get the currently focused window ID."""
        result = await self.exec.run("xdotool getwindowfocus", env={"DISPLAY": DISPLAY})
        return result.stdout.strip()

    async def get_application_windows(self, application: str) -> list[str]:
        """Get all visible window IDs for an application class."""
        result = await self.exec.run(
            f"xdotool search --onlyvisible --class {application}",
            env={"DISPLAY": DISPLAY},
        )
        return [w for w in result.stdout.strip().split("\n") if w]

    async def get_window_title(self, window_id: str) -> str:
        """Get the title of a window by ID."""
        result = await self.exec.run(f"xdotool getwindowname {window_id}", env={"DISPLAY": DISPLAY})
        return result.stdout.strip()

    async def wait(self, ms: int) -> None:
        """Wait for a given duration (in milliseconds)."""
        await self.exec.run(f"sleep {ms / 1000}")
