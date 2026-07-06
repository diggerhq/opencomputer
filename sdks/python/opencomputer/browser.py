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


@dataclass
class BrowserRun:
    """Browser runner execution state."""

    id: str
    status: str
    type: str = "workflow"
    workflow_id: str | None = None
    concurrency: str | None = None
    input: dict[str, Any] | None = None
    definition: dict[str, Any] | None = None
    output: Any = None
    error: Any = None
    trigger_run_id: str | None = None
    jobs: list[dict[str, Any]] | None = None
    steps: list[dict[str, Any]] | None = None
    created_at: str | None = None
    updated_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    canceled_at: str | None = None
    _api_url: str = ""
    _api_key: str = ""
    _client: httpx.AsyncClient | None = None

    @classmethod
    async def create(
        cls,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
        browser: dict[str, Any] | None = None,
        mode: str | None = None,
        task: str | None = None,
        script: str | None = None,
        input: dict[str, Any] | None = None,
        save_profile: bool | None = None,
        close_browser: bool | None = None,
    ) -> BrowserRun:
        """Create a single browser run."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        body = _create_body(
            browser=browser,
            mode=mode,
            task=task,
            script=script,
            input=input,
            saveProfile=save_profile,
            closeBrowser=close_browser,
        )
        resp = await client.post("/v1/browser-runs", json=body)
        resp.raise_for_status()
        return cls._from_data(resp.json(), url, key, client)

    @classmethod
    async def connect(
        cls,
        run_id: str,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
    ) -> BrowserRun:
        """Load a browser run by ID."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        endpoint = "browser-runs" if run_id.startswith("brun_") else "browser-workflow-runs"
        resp = await client.get(f"/v1/{endpoint}/{run_id}")
        resp.raise_for_status()
        return cls._from_data(resp.json(), url, key, client)

    async def refresh(self) -> BrowserRun:
        """Reload the run state."""
        return await BrowserRun.connect(self.id, api_key=self._api_key, api_url=self._api_url)

    async def wait(self, *, interval_seconds: float = 1.0, timeout_seconds: float = 300.0) -> BrowserRun:
        """Poll until the run reaches a terminal status."""
        import asyncio
        import time

        deadline = time.monotonic() + timeout_seconds
        current: BrowserRun = self
        while current.status not in {"completed", "failed", "canceled", "expired"}:
            if time.monotonic() > deadline:
                raise TimeoutError(f"Timed out waiting for browser run {self.id}")
            await asyncio.sleep(interval_seconds)
            current = await current.refresh()
        return current

    @classmethod
    def _from_data(
        cls,
        data: dict[str, Any],
        api_url: str,
        api_key: str,
        client: httpx.AsyncClient,
    ) -> BrowserRun:
        return cls(
            id=data["id"],
            type=data.get("type", "workflow"),
            status=data["status"],
            workflow_id=data.get("workflow_id"),
            concurrency=data.get("concurrency"),
            input=data.get("input"),
            definition=data.get("definition"),
            output=data.get("output"),
            error=data.get("error"),
            trigger_run_id=data.get("trigger_run_id"),
            jobs=data.get("jobs", []),
            steps=data.get("steps", []),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
            started_at=data.get("started_at"),
            finished_at=data.get("finished_at"),
            canceled_at=data.get("canceled_at"),
            _api_url=api_url,
            _api_key=api_key,
            _client=client,
        )


@dataclass
class BrowserWorkflow:
    """Reusable browser workflow definition."""

    id: str
    name: str
    definition: dict[str, Any]
    description: str | None = None
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
        name: str,
        jobs: dict[str, Any],
        description: str | None = None,
        concurrency: str | None = None,
    ) -> BrowserWorkflow:
        """Create a reusable browser workflow."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        body = _create_body(name=name, description=description, concurrency=concurrency, jobs=jobs)
        resp = await client.post("/v1/browser-workflows", json=body)
        resp.raise_for_status()
        return cls._from_data(resp.json(), url, key, client)

    @classmethod
    async def connect(
        cls,
        workflow_id: str,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
    ) -> BrowserWorkflow:
        """Load a browser workflow by ID."""
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        resp = await client.get(f"/v1/browser-workflows/{workflow_id}")
        resp.raise_for_status()
        return cls._from_data(resp.json(), url, key, client)

    async def run(self, *, input: dict[str, Any] | None = None) -> BrowserRun:
        """Start a run from this workflow."""
        return await BrowserWorkflowRun.create(
            workflow_id=self.id,
            input=input,
            api_key=self._api_key,
            api_url=self._api_url,
        )

    @classmethod
    def _from_data(
        cls,
        data: dict[str, Any],
        api_url: str,
        api_key: str,
        client: httpx.AsyncClient,
    ) -> BrowserWorkflow:
        return cls(
            id=data["id"],
            name=data["name"],
            description=data.get("description"),
            definition=data["definition"],
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
            deleted_at=data.get("deleted_at"),
            _api_url=api_url,
            _api_key=api_key,
            _client=client,
        )


class BrowserWorkflowRun:
    """Factory for workflow executions."""

    @classmethod
    async def create(
        cls,
        *,
        api_key: str | None = None,
        api_url: str | None = None,
        workflow_id: str | None = None,
        workflow: dict[str, Any] | None = None,
        input: dict[str, Any] | None = None,
    ) -> BrowserRun:
        url = _resolve_browser_api_url(api_url)
        key = api_key or os.environ.get("OPENCOMPUTER_API_KEY", "")
        client = httpx.AsyncClient(base_url=url, headers=_headers(key), timeout=30.0)
        body = _create_body(workflowId=workflow_id, workflow=workflow, input=input)
        resp = await client.post("/v1/browser-workflow-runs", json=body)
        resp.raise_for_status()
        return BrowserRun._from_data(resp.json(), url, key, client)


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
