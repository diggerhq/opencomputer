"""Browser entity for OpenComputer's browser API."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx


DEFAULT_BROWSER_API_URL = "https://browser.opencomputer.dev"


def _resolve_browser_api_url(api_url: str | None) -> str:
    return (api_url or os.environ.get("OPENCOMPUTER_BROWSER_API_URL") or DEFAULT_BROWSER_API_URL).rstrip("/")


@dataclass
class Browser:
    """Browser session managed through OpenComputer."""

    id: str
    provider: str
    provider_session_id: str
    status: str
    cdp_ws_url: str
    webdriver_ws_url: str
    live_view_url: str | None = None
    base_url: str | None = None
    headless: bool | None = None
    stealth: bool | None = None
    gpu: bool | None = None
    timeout_seconds: int | None = None
    created_at: str | None = None
    updated_at: str | None = None
    deleted_at: str | None = None
    _api_url: str = ""
    _api_key: str = ""
    _client: httpx.AsyncClient | None = None

    @classmethod
    async def create(
        cls,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
        name: str | None = None,
        tags: dict[str, str] | None = None,
        stealth: bool | None = None,
        headless: bool | None = None,
        gpu: bool | None = None,
        timeout_seconds: int | None = None,
        profile: dict[str, Any] | None = None,
        extensions: list[dict[str, str]] | None = None,
        proxy_id: str | None = None,
        viewport: dict[str, int] | None = None,
        kiosk_mode: bool | None = None,
        start_url: str | None = None,
        chrome_policy: dict[str, Any] | None = None,
        telemetry: dict[str, Any] | None = None,
    ) -> Browser:
        """Create a browser session and return direct connection URLs."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)

        body = _create_body(
            name=name,
            tags=tags,
            stealth=stealth,
            headless=headless,
            gpu=gpu,
            timeout_seconds=timeout_seconds,
            profile=profile,
            extensions=extensions,
            proxy_id=proxy_id,
            viewport=viewport,
            kiosk_mode=kiosk_mode,
            start_url=start_url,
            chrome_policy=chrome_policy,
            telemetry=telemetry,
        )
        resp = await client.post("/v1/browsers", json=body)
        resp.raise_for_status()
        return cls._from_data(resp.json(), url, key, client)

    @classmethod
    async def connect(
        cls,
        browser_id: str,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
    ) -> Browser:
        """Load an existing browser session by OpenComputer browser ID."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        resp = await client.get(f"/v1/browsers/{browser_id}")
        resp.raise_for_status()
        return cls._from_data(resp.json(), url, key, client)

    async def delete(self) -> None:
        """Delete the browser session."""
        client = self._client or httpx.AsyncClient(base_url=self._api_url, headers=_headers(self._api_key), timeout=30.0)
        resp = await client.delete(f"/v1/browsers/{self.id}")
        resp.raise_for_status()

    async def close(self) -> None:
        """Close the SDK HTTP client. This does not delete the browser."""
        if self._client is not None:
            await self._client.aclose()

    @classmethod
    def _from_data(
        cls,
        data: dict[str, Any],
        api_url: str,
        api_key: str,
        client: httpx.AsyncClient,
    ) -> Browser:
        return cls(
            id=data["id"],
            provider=data.get("provider", "kernel"),
            provider_session_id=data["provider_session_id"],
            status=data.get("status", ""),
            cdp_ws_url=data["cdp_ws_url"],
            webdriver_ws_url=data["webdriver_ws_url"],
            live_view_url=data.get("live_view_url"),
            base_url=data.get("base_url"),
            headless=data.get("headless"),
            stealth=data.get("stealth"),
            gpu=data.get("gpu"),
            timeout_seconds=data.get("timeout_seconds"),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
            deleted_at=data.get("deleted_at"),
            _api_url=api_url,
            _api_key=api_key,
            _client=client,
        )


@dataclass
class BrowserProfile:
    """Browser profile metadata managed through OpenComputer."""

    id: str
    provider: str
    provider_profile_id: str
    name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    deleted_at: str | None = None
    provider_created_at: str | None = None
    provider_updated_at: str | None = None
    provider_last_used_at: str | None = None
    _api_url: str = ""
    _api_key: str = ""
    _client: httpx.AsyncClient | None = None

    @classmethod
    async def create(
        cls,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
        name: str | None = None,
    ) -> BrowserProfile:
        """Create a browser profile."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        body = {"name": name} if name is not None else {}
        resp = await client.post("/v1/profiles", json=body)
        resp.raise_for_status()
        return cls._from_data(resp.json(), url, key, client)

    @classmethod
    async def list(
        cls,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
    ) -> list[BrowserProfile]:
        """List browser profiles for the authenticated org."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        resp = await client.get("/v1/profiles")
        resp.raise_for_status()
        data = resp.json()
        return [cls._from_data(item, url, key, client) for item in data.get("profiles", [])]

    @classmethod
    async def connect(
        cls,
        id_or_name: str,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
    ) -> BrowserProfile:
        """Load a browser profile by OpenComputer profile ID or name."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        resp = await client.get(f"/v1/profiles/{id_or_name}")
        resp.raise_for_status()
        return cls._from_data(resp.json(), url, key, client)

    async def delete(self) -> None:
        """Delete the browser profile."""
        client = self._client or httpx.AsyncClient(base_url=self._api_url, headers=_headers(self._api_key), timeout=30.0)
        resp = await client.delete(f"/v1/profiles/{self.id}")
        resp.raise_for_status()

    async def close(self) -> None:
        """Close the SDK HTTP client. This does not delete the profile."""
        if self._client is not None:
            await self._client.aclose()

    @classmethod
    def _from_data(
        cls,
        data: dict[str, Any],
        api_url: str,
        api_key: str,
        client: httpx.AsyncClient,
    ) -> BrowserProfile:
        return cls(
            id=data["id"],
            provider=data.get("provider", "kernel"),
            provider_profile_id=data["provider_profile_id"],
            name=data.get("name"),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
            deleted_at=data.get("deleted_at"),
            provider_created_at=data.get("provider_created_at"),
            provider_updated_at=data.get("provider_updated_at"),
            provider_last_used_at=data.get("provider_last_used_at"),
            _api_url=api_url,
            _api_key=api_key,
            _client=client,
        )


def _headers(api_key: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key
    return headers


def _create_body(**kwargs: Any) -> dict[str, Any]:
    body: dict[str, Any] = {}
    for key, value in kwargs.items():
        if value is not None:
            body[key] = value
    return body
