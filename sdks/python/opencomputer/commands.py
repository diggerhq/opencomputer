"""Command execution inside a sandbox."""

from __future__ import annotations

import json
from dataclasses import dataclass
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
    ) -> ProcessResult:
        """Run a command and wait for completion."""
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

    async def stream(
        self,
        command: str,
        timeout: int = 60,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        on_stdout: Callable[[str], None] | None = None,
        on_stderr: Callable[[str], None] | None = None,
    ) -> ProcessResult:
        """Execute a command and stream output in real time via SSE.

        Args:
            command: The command to run.
            timeout: Timeout in seconds (default 60).
            env: Optional environment variables.
            cwd: Optional working directory.
            on_stdout: Callback for each stdout chunk.
            on_stderr: Callback for each stderr chunk.

        Returns:
            ProcessResult with exit code and accumulated stdout/stderr.
        """
        body: dict[str, Any] = {
            "cmd": command,
            "timeout": timeout,
        }
        if env:
            body["envs"] = env
        if cwd:
            body["cwd"] = cwd

        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        exit_code = -1

        # Read timeout must exceed the server keepalive interval (15s).
        # The server sends keepalive comments so the connection stays alive
        # even when the command produces no output.
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
                # Parse SSE events from buffer
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
                        raise RuntimeError(f"Stream exec error: {payload['error']}")

        return ProcessResult(
            exit_code=exit_code,
            stdout="".join(stdout_parts),
            stderr="".join(stderr_parts),
        )

    async def stream_iter(
        self,
        command: str,
        timeout: int = 60,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> AsyncIterator[ExecChunk]:
        """Execute a command and yield output chunks as an async iterator.

        Args:
            command: The command to run.
            timeout: Timeout in seconds (default 60).
            env: Optional environment variables.
            cwd: Optional working directory.

        Yields:
            ExecChunk for each stdout/stderr output chunk.
        """
        body: dict[str, Any] = {
            "cmd": command,
            "timeout": timeout,
        }
        if env:
            body["envs"] = env
        if cwd:
            body["cwd"] = cwd

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
                        yield ExecChunk(stream=event["type"], data=payload["data"])
                    elif event["type"] == "error":
                        payload = json.loads(event["data"])
                        raise RuntimeError(f"Stream exec error: {payload['error']}")


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
