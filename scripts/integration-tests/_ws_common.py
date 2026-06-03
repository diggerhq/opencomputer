"""Shared helpers for the WS edge integration tests (05-08).

Reads OPENCOMPUTER_API_URL + OPENCOMPUTER_API_KEY from env. Exits 2 with a
useful message if either is missing so the tests don't surface NameErrors.
"""
from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager

import httpx
import websockets


def _env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print(
            f"missing required env var {name}; "
            "set OPENCOMPUTER_API_URL + OPENCOMPUTER_API_KEY (see scripts/integration-tests/README.md)",
            file=sys.stderr,
        )
        sys.exit(2)
    return v


API_URL = _env("OPENCOMPUTER_API_URL").rstrip("/")
API_KEY = _env("OPENCOMPUTER_API_KEY")
WS_URL = API_URL.replace("https://", "wss://").replace("http://", "ws://")


@asynccontextmanager
async def edge_client():
    """httpx client preconfigured against the edge with the API key."""
    headers = {"X-API-Key": API_KEY, "content-type": "application/json"}
    async with httpx.AsyncClient(base_url=API_URL, headers=headers, timeout=60.0) as c:
        yield c


async def create_sandbox(client: httpx.AsyncClient, template: str = "base", timeout_s: int = 3600) -> dict:
    r = await client.post("/api/sandboxes", json={"templateID": template, "timeout": timeout_s})
    r.raise_for_status()
    return r.json()


async def delete_sandbox(client: httpx.AsyncClient, sandbox_id: str) -> None:
    try:
        await client.delete(f"/api/sandboxes/{sandbox_id}")
    except Exception:
        # best-effort cleanup; test result has already been decided
        pass


async def list_workers(client: httpx.AsyncClient) -> list[dict]:
    r = await client.get("/api/workers")
    r.raise_for_status()
    return r.json()


async def open_pty(client: httpx.AsyncClient, sandbox_id: str, cols: int = 80, rows: int = 24):
    """POST /pty to create a session, then upgrade WS to /pty/{session_id}.
    Returns (session_id, websocket)."""
    pty = (await client.post(
        f"/api/sandboxes/{sandbox_id}/pty",
        json={"cols": cols, "rows": rows},
    )).json()
    sid = pty["sessionID"]
    ws = await websockets.connect(
        f"{WS_URL}/api/sandboxes/{sandbox_id}/pty/{sid}?api_key={API_KEY}",
        additional_headers={"X-API-Key": API_KEY},
    )
    return sid, ws


async def open_exec(client: httpx.AsyncClient, sandbox_id: str, shell_cmd: str):
    """POST /exec to spawn `bash -lc <shell_cmd>`, then upgrade WS to
    /exec/{session_id}. Returns (session_id, websocket)."""
    es = (await client.post(
        f"/api/sandboxes/{sandbox_id}/exec",
        json={"cmd": "bash", "args": ["-lc", shell_cmd]},
    )).json()
    sid = es["sessionID"]
    ws = await websockets.connect(
        f"{WS_URL}/api/sandboxes/{sandbox_id}/exec/{sid}?api_key={API_KEY}",
        additional_headers={"X-API-Key": API_KEY},
    )
    return sid, ws
