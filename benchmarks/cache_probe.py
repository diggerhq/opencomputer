#!/usr/bin/env python3
"""
Probe whether E2B/Daytona/OpenSandbox use npm cache or registry proxy.

Strategy:
  1. Install express (popular, likely cached) — compare times
  2. Install an obscure package (unlikely cached) — compare times
  3. Run `npm cache ls` to check if cache is pre-warmed
  4. Check for registry proxy env vars (npm_config_registry, etc.)

If cached: express fast, obscure slow.
If proxy: both fast.
If neither: both slow.
"""

import asyncio
import os
import time


async def probe_opensandbox():
    from opensandbox import Sandbox

    print("\n--- OpenSandbox ---")
    sb = await Sandbox.create(template="node", timeout=120)
    try:
        # Check hardware
        r = await sb.commands.run("nproc && cat /proc/meminfo | grep MemTotal && cat /proc/cpuinfo | grep 'model name' | head -1 || true", timeout=10)
        print(f"  hardware:\n    {r.stdout.strip().replace(chr(10), chr(10) + '    ')}")

    finally:
        await sb.kill()


def probe_e2b():
    from e2b import Sandbox

    print("\n--- E2B ---")
    sb = Sandbox.create(timeout=120)
    try:
        # Check hardware
        r = sb.commands.run("nproc && cat /proc/meminfo | grep MemTotal && cat /proc/cpuinfo | grep 'model name' | head -1 || true", timeout=10)
        print(f"  hardware:\n    {r.stdout.strip().replace(chr(10), chr(10) + '    ')}")

    finally:
        sb.kill()


def probe_daytona():
    from daytona import Daytona, CreateSandboxFromImageParams

    print("\n--- Daytona ---")
    client = Daytona()
    sb = client.create(
        params=CreateSandboxFromImageParams(image="node:20", auto_stop_interval=0),
        timeout=60,
    )
    try:
        home = "/home/daytona"

        # Check hardware
        r = sb.process.exec("nproc && cat /proc/meminfo | grep MemTotal && cat /proc/cpuinfo | grep 'model name' | head -1 || true", timeout=10)
        print(f"  hardware:\n    {r.result.strip().replace(chr(10), chr(10) + '    ')}")

        # Check npm config
        r = sb.process.exec("npm config get registry && npm config get cache && env | grep -i npm || true", timeout=10)
        print(f"  npm config:\n    {r.result.strip().replace(chr(10), chr(10) + '    ')}")

        # Check cache
        r = sb.process.exec("ls -la ~/.npm/_cacache 2>/dev/null && du -sh ~/.npm 2>/dev/null || echo 'no cache'", timeout=10)
        print(f"  cache status: {r.result.strip()}")

        # Install express
        t = time.time()
        r = sb.process.exec(f"mkdir -p {home}/test1 && cd {home}/test1 && echo '{{\"name\":\"t\"}}' > package.json && npm install express 2>&1 | tail -3", timeout=120)
        print(f"  npm install express: {time.time()-t:.1f}s\n    {r.result.strip().replace(chr(10), chr(10) + '    ')}")

        # Install obscure package
        t = time.time()
        r = sb.process.exec(f"mkdir -p {home}/test2 && cd {home}/test2 && echo '{{\"name\":\"t\"}}' > package.json && npm install @anthropic-ai/tokenizer 2>&1 | tail -3", timeout=120)
        print(f"  npm install @anthropic-ai/tokenizer: {time.time()-t:.1f}s\n    {r.result.strip().replace(chr(10), chr(10) + '    ')}")

    finally:
        sb.delete()


async def main():
    print("=" * 60)
    print("NPM CACHE / PROXY PROBE")
    print("=" * 60)

    # Run all three
    for name, fn in [("opensandbox", probe_opensandbox), ("e2b", probe_e2b), ("daytona", probe_daytona)]:
        try:
            if asyncio.iscoroutinefunction(fn):
                await fn()
            else:
                fn()
        except Exception as e:
            print(f"\n--- {name} FAILED: {e} ---")


if __name__ == "__main__":
    asyncio.run(main())
