"""Quick smoke test for OpenComputer production (app.opencomputer.dev)."""

import asyncio
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdks", "python"))

from opencomputer import Sandbox

API_URL = os.environ.get("OPENCOMPUTER_API_URL", "https://app.opencomputer.dev")
API_KEY = os.environ.get("OPENCOMPUTER_API_KEY", "")

passed = 0
failed = 0


def check(name, ok):
    global passed, failed
    if ok:
        passed += 1
        print(f"  \033[32m✓\033[0m {name}")
    else:
        failed += 1
        print(f"  \033[31m✗\033[0m {name}")


async def main():
    global passed, failed

    print(f"Testing against {API_URL}\n")

    # 1. Create sandbox
    print("1. Create sandbox")
    t0 = time.time()
    sb = await Sandbox.create(
        template="base",
        timeout=120,
        api_url=API_URL,
        api_key=API_KEY,
    )
    dt = time.time() - t0
    check(f"sandbox created: {sb.sandbox_id} ({dt:.1f}s)", sb.sandbox_id != "")
    check(f"status is running", sb.status == "running")

    try:
        # 2. Run commands
        print("\n2. Commands")
        result = await sb.commands.run("echo hello")
        check("echo hello", result.stdout.strip() == "hello")
        check("exit code 0", result.exit_code == 0)

        result = await sb.commands.run("uname -s")
        check(f"uname: {result.stdout.strip()}", result.stdout.strip() == "Linux")

        result = await sb.commands.run("cat /etc/os-release | head -1")
        check(f"os-release: {result.stdout.strip()}", result.exit_code == 0)

        # 3. Filesystem
        print("\n3. Filesystem")
        await sb.files.write("/tmp/test.txt", "hello opencomputer")
        content = await sb.files.read("/tmp/test.txt")
        check("write + read file", content.strip() == "hello opencomputer")

        entries = await sb.files.list("/tmp")
        names = [e.name for e in entries]
        check("list dir contains test.txt", "test.txt" in names)

        await sb.commands.run("mkdir -p /tmp/testdir")
        entries = await sb.files.list("/tmp")
        names = [e.name for e in entries]
        check("mkdir + list", "testdir" in names)

        # 4. Reconnect
        print("\n4. Reconnect")
        sb2 = await Sandbox.connect(sb.sandbox_id, api_url=API_URL, api_key=API_KEY)
        check(f"reconnected to {sb2.sandbox_id}", sb2.sandbox_id == sb.sandbox_id)
        result = await sb2.commands.run("cat /tmp/test.txt")
        check("state persisted", result.stdout.strip() == "hello opencomputer")
        await sb2.close()

        # 5. Kill
        print("\n5. Cleanup")
        await sb.kill()
        check("sandbox killed", sb.status == "stopped")

    except Exception as e:
        print(f"\n\033[31mERROR: {e}\033[0m")
        failed += 1
        try:
            await sb.kill()
        except Exception:
            pass

    await sb.close()

    # Summary
    total = passed + failed
    print(f"\n{'='*40}")
    if failed == 0:
        print(f"\033[32mAll {total} checks passed\033[0m")
    else:
        print(f"\033[31m{failed}/{total} checks failed\033[0m")
    return 1 if failed else 0


if __name__ == "__main__":
    rc = asyncio.run(main())
    sys.exit(rc)
