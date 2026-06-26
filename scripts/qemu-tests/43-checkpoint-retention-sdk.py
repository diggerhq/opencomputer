#!/usr/bin/env python3
"""Checkpoint retention through the Python SDK.

Usage:
  OPENSANDBOX_API_URL=https://mo-oc-dev.com OPENSANDBOX_API_KEY=... \
    python3 scripts/qemu-tests/43-checkpoint-retention-sdk.py
"""

import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdks", "python"))
from opencomputer import Sandbox  # noqa: E402

MAX_COUNT = int(os.environ.get("MAX_COUNT", "3"))
READY_TIMEOUT_SECONDS = int(os.environ.get("READY_TIMEOUT_SECONDS", "900"))
RETENTION_ONLY = os.environ.get("RETENTION_ONLY") == "1"
API_URL = os.environ.get("OPENCOMPUTER_API_URL") or os.environ.get("OPENSANDBOX_API_URL")
API_KEY = os.environ.get("OPENCOMPUTER_API_KEY") or os.environ.get("OPENSANDBOX_API_KEY")

PASS = 0
FAIL = 0


def ok(message: str) -> None:
    global PASS
    PASS += 1
    print(f"PASS {message}")


def bad(message: str) -> None:
    global FAIL
    FAIL += 1
    print(f"FAIL {message}", file=sys.stderr)


def summary() -> None:
    print(f"{PASS} passed, {FAIL} failed")
    raise SystemExit(0 if FAIL == 0 else 1)


async def wait_for_checkpoint_ready(sandbox: Sandbox, name: str) -> bool:
    deadline = time.time() + READY_TIMEOUT_SECONDS
    while time.time() < deadline:
        checkpoints = await sandbox.list_checkpoints()
        cp = next((checkpoint for checkpoint in checkpoints if checkpoint.get("name") == name), None)
        if cp and cp.get("status") == "ready":
            return True
        if cp and cp.get("status") != "processing":
            return False
        await asyncio.sleep(5)
    return False


async def main() -> None:
    if MAX_COUNT < 1 or MAX_COUNT > 10:
        raise ValueError("MAX_COUNT must be between 1 and 10")

    sandbox = None
    prefix = f"py-retention-{int(time.time())}"
    total = MAX_COUNT + 1

    try:
        sandbox = await Sandbox.create(api_url=API_URL, api_key=API_KEY, timeout=3600)
        ok(f"sandbox running: {sandbox.sandbox_id}")

        for i in range(1, total + 1):
            name = f"{prefix}-{i}"
            cp = await sandbox.create_checkpoint(
                name,
                retention_policy={"mode": "delete_oldest", "maxCount": MAX_COUNT},
            )
            ok(f"created checkpoint {i}/{total}: {name} ({cp.get('id')})")

            if RETENTION_ONLY and i == total:
                ok("retention checkpoint accepted without hard-cap error")
                break

            if await wait_for_checkpoint_ready(sandbox, name):
                ok(f"checkpoint ready: {name}")
            else:
                bad(f"checkpoint did not become ready: {name}")
                summary()

        checkpoints = await sandbox.list_checkpoints()
        names = [checkpoint.get("name") for checkpoint in checkpoints]

        if len(names) == MAX_COUNT:
            ok(f"checkpoint count retained at {MAX_COUNT}")
        else:
            bad(f"checkpoint count is {len(names)}, expected {MAX_COUNT}")

        if f"{prefix}-1" not in names:
            ok("oldest checkpoint was deleted by retention")
        else:
            bad("oldest checkpoint still exists after retention")

        if f"{prefix}-{total}" in names:
            ok("newest checkpoint exists after retention")
        else:
            bad("newest checkpoint missing after retention")
    finally:
        if sandbox is not None:
            try:
                await sandbox.kill()
            except Exception:
                pass
            await sandbox.close()

    summary()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        bad(str(exc))
        summary()
