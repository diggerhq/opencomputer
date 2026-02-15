"""Sandbox class - main entry point for the OpenSandbox SDK."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import httpx

from opensandbox.commands import Commands
from opensandbox.filesystem import Filesystem
from opensandbox.pty import Pty


@dataclass
class Sandbox:
    """E2B-compatible sandbox interface."""

    sandbox_id: str
    status: str = "running"
    template: str = ""
    _api_url: str = ""
    _api_key: str = ""
    _client: httpx.AsyncClient = field(default=None, repr=False)

    @classmethod
    async def create(
        cls,
        template: str = "base",
        timeout: int = 300,
        api_key: str | None = None,
        api_url: str | None = None,
        envs: dict[str, str] | None = None,
        metadata: dict[str, str] | None = None,
    ) -> Sandbox:
        """Create a new sandbox instance."""
        url = api_url or os.environ.get("OPENSANDBOX_API_URL", "http://localhost:8080")
        key = api_key or os.environ.get("OPENSANDBOX_API_KEY", "")

        headers = {}
        if key:
            headers["X-API-Key"] = key

        client = httpx.AsyncClient(base_url=url, headers=headers, timeout=30.0)

        body: dict[str, Any] = {
            "templateID": template,
            "timeout": timeout,
        }
        if envs:
            body["envs"] = envs
        if metadata:
            body["metadata"] = metadata

        resp = await client.post("/sandboxes", json=body)
        resp.raise_for_status()
        data = resp.json()

        return cls(
            sandbox_id=data["sandboxID"],
            status=data.get("status", "running"),
            template=template,
            _api_url=url,
            _api_key=key,
            _client=client,
        )

    @classmethod
    async def connect(
        cls,
        sandbox_id: str,
        api_key: str | None = None,
        api_url: str | None = None,
    ) -> Sandbox:
        """Connect to an existing sandbox."""
        url = api_url or os.environ.get("OPENSANDBOX_API_URL", "http://localhost:8080")
        key = api_key or os.environ.get("OPENSANDBOX_API_KEY", "")

        headers = {}
        if key:
            headers["X-API-Key"] = key

        client = httpx.AsyncClient(base_url=url, headers=headers, timeout=30.0)

        resp = await client.get(f"/sandboxes/{sandbox_id}")
        resp.raise_for_status()
        data = resp.json()

        return cls(
            sandbox_id=sandbox_id,
            status=data.get("status", "running"),
            template=data.get("templateID", ""),
            _api_url=url,
            _api_key=key,
            _client=client,
        )

    async def kill(self) -> None:
        """Kill and remove the sandbox."""
        resp = await self._client.delete(f"/sandboxes/{self.sandbox_id}")
        resp.raise_for_status()
        self.status = "stopped"

    async def is_running(self) -> bool:
        """Check if the sandbox is still running."""
        try:
            resp = await self._client.get(f"/sandboxes/{self.sandbox_id}")
            resp.raise_for_status()
            data = resp.json()
            self.status = data.get("status", "stopped")
            return self.status == "running"
        except httpx.HTTPStatusError:
            return False

    async def set_timeout(self, timeout: int) -> None:
        """Update the sandbox timeout in seconds."""
        resp = await self._client.post(
            f"/sandboxes/{self.sandbox_id}/timeout",
            json={"timeout": timeout},
        )
        resp.raise_for_status()

    @property
    def files(self) -> Filesystem:
        """Access filesystem operations."""
        return Filesystem(self._client, self.sandbox_id)

    @property
    def commands(self) -> Commands:
        """Access command execution."""
        return Commands(self._client, self.sandbox_id)

    @property
    def pty(self) -> Pty:
        """Access PTY terminal sessions."""
        return Pty(self._client, self.sandbox_id, self._api_url, self._api_key)

    async def close(self) -> None:
        """Close the HTTP client (does not kill the sandbox)."""
        await self._client.aclose()

    async def __aenter__(self) -> Sandbox:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.kill()
        await self.close()
