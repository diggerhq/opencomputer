"""Command execution inside a sandbox."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

import httpx


@dataclass
class ProcessResult:
    """Result of a command execution."""

    exit_code: int
    stdout: str
    stderr: str


@dataclass
class ExecChunk:
    """A single chunk of streaming command output."""

    stream: str  # "stdout" or "stderr"
    data: str


@dataclass
class CommandHandle:
    """Handle for a background process running in the sandbox."""

    session_id: str
    _client: httpx.AsyncClient = field(repr=False)
    _sandbox_id: str = field(repr=False)

    async def kill(self) -> None:
        """Kill the background process."""
        await self._client.delete(
            f"/sandboxes/{self._sandbox_id}/pty/{self.session_id}",
        )

    async def send_input(self, data: str) -> None:
        """Send data to the process's stdin (requires websocket — placeholder)."""
        raise NotImplementedError(
            "Use the PTY websocket to send stdin to background processes"
        )


@dataclass
class Commands:
    """Command execution for a sandbox."""

    _client: httpx.AsyncClient
    _sandbox_id: str

    async def run(
        self,
        command: str,
        timeout: int = 60,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        on_stdout: Callable[[str], None] | None = None,
        on_stderr: Callable[[str], None] | None = None,
        tty: bool = False,
        background: bool = False,
    ) -> ProcessResult | CommandHandle:
        """Run a command in the sandbox.

        Args:
            command: The command to run.
            timeout: Timeout in seconds (default 60).
            env: Optional environment variables.
            cwd: Optional working directory.
            on_stdout: Callback for each stdout chunk (enables streaming).
            on_stderr: Callback for each stderr chunk (enables streaming).
            tty: Allocate a PTY for real-time unbuffered output.
            background: Start the process in the background and return a
                CommandHandle immediately. The process runs in a PTY session
                and survives client disconnect.

        Returns:
            ProcessResult for foreground commands, CommandHandle for background.
        """
        if background:
            return await self._run_background(command, env=env, cwd=cwd)

        if on_stdout or on_stderr or tty:
            return await self._run_streaming(
                command, timeout=timeout, env=env, cwd=cwd,
                on_stdout=on_stdout, on_stderr=on_stderr, tty=tty,
            )

        return await self._run_simple(command, timeout=timeout, env=env, cwd=cwd)

    async def connect(self, session_id: str) -> CommandHandle:
        """Connect to an already-running background process by session ID."""
        return CommandHandle(
            session_id=session_id,
            _client=self._client,
            _sandbox_id=self._sandbox_id,
        )

    async def kill(self, session_id: str) -> None:
        """Kill a background process by session ID."""
        await self._client.delete(
            f"/sandboxes/{self._sandbox_id}/pty/{session_id}",
        )

    # --- Private implementations ---

    async def _run_simple(
        self,
        command: str,
        timeout: int = 60,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> ProcessResult:
        body: dict[str, Any] = {
            "cmd": command,
            "timeout": timeout,
        }
        if env:
            body["envs"] = env
        if cwd:
            body["cwd"] = cwd

        resp = await self._client.post(
            f"/sandboxes/{self._sandbox_id}/commands",
            json=body,
            timeout=timeout + 5,
        )
        resp.raise_for_status()
        data = resp.json()

        return ProcessResult(
            exit_code=data.get("exitCode", -1),
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
        )

    async def _run_streaming(
        self,
        command: str,
        timeout: int = 60,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        on_stdout: Callable[[str], None] | None = None,
        on_stderr: Callable[[str], None] | None = None,
        tty: bool = False,
    ) -> ProcessResult:
        body: dict[str, Any] = {
            "cmd": command,
            "timeout": timeout,
        }
        if env:
            body["envs"] = env
        if cwd:
            body["cwd"] = cwd
        if tty:
            body["tty"] = True

        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        exit_code = -1

        read_timeout = timeout + 30
        async with self._client.stream(
            "POST",
            f"/sandboxes/{self._sandbox_id}/exec",
            json=body,
            timeout=httpx.Timeout(5.0, read=read_timeout),
        ) as resp:
            resp.raise_for_status()
            buffer = ""
            async for raw in resp.aiter_text():
                buffer += raw
                while "\n\n" in buffer:
                    event_str, buffer = buffer.split("\n\n", 1)
                    event = _parse_sse_event(event_str)
                    if event is None:
                        continue

                    if event["type"] in ("stdout", "stderr"):
                        payload = json.loads(event["data"])
                        chunk_data = payload["data"]
                        if event["type"] == "stdout":
                            stdout_parts.append(chunk_data)
                            if on_stdout:
                                on_stdout(chunk_data)
                        else:
                            stderr_parts.append(chunk_data)
                            if on_stderr:
                                on_stderr(chunk_data)
                    elif event["type"] == "exit":
                        payload = json.loads(event["data"])
                        exit_code = payload["exit_code"]
                    elif event["type"] == "error":
                        payload = json.loads(event["data"])
                        raise RuntimeError(f"Exec error: {payload['error']}")

        return ProcessResult(
            exit_code=exit_code,
            stdout="".join(stdout_parts),
            stderr="".join(stderr_parts),
        )

    async def _run_background(
        self,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> CommandHandle:
        # Create a PTY session
        resp = await self._client.post(
            f"/sandboxes/{self._sandbox_id}/pty",
            json={"cols": 120, "rows": 40},
        )
        resp.raise_for_status()
        session_id = resp.json()["sessionID"]

        # Build the command with env/cwd prefixes
        parts = []
        if env:
            for k, v in env.items():
                parts.append(f"export {k}={_shell_escape(v)}")
        if cwd:
            parts.append(f"cd {_shell_escape(cwd)}")
        parts.append(command)
        full_cmd = " && ".join(parts)

        # Send command via a short-lived websocket
        import websockets  # type: ignore

        ws_url = str(self._client.base_url).replace("http://", "ws://").replace("https://", "wss://")
        ws_endpoint = f"{ws_url}/sandboxes/{self._sandbox_id}/pty/{session_id}"

        async with websockets.connect(ws_endpoint) as ws:
            await ws.send(full_cmd + "\n")

        return CommandHandle(
            session_id=session_id,
            _client=self._client,
            _sandbox_id=self._sandbox_id,
        )


def _parse_sse_event(raw: str) -> dict[str, str] | None:
    """Parse a single SSE event block into type + data."""
    event_type = "message"
    data = ""
    for line in raw.split("\n"):
        if line.startswith("event: "):
            event_type = line[7:].strip()
        elif line.startswith("data: "):
            data = line[6:]
    if not data:
        return None
    return {"type": event_type, "data": data}


def _shell_escape(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"
