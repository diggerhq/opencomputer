"""Test sandbox domain preview by starting an HTTP server inside the sandbox."""

import asyncio
import sys
import os
import time

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdks", "python"))

from opencomputer import Sandbox

API_URL = os.environ.get("OPENCOMPUTER_API_URL", "https://app.opencomputer.dev")
API_KEY = os.environ.get("OPENCOMPUTER_API_KEY", "")


async def main():
    print(f"Testing sandbox preview against {API_URL}\n")

    # 1. Create sandbox
    print("1. Creating sandbox...")
    t0 = time.time()
    sb = await Sandbox.create(
        template="base",
        timeout=120,
        api_url=API_URL,
        api_key=API_KEY,
    )
    dt = time.time() - t0
    print(f"   Sandbox: {sb.sandbox_id} ({dt:.1f}s)")
    print(f"   Domain:  {sb.domain}")
    print(f"   URL:     https://{sb.domain}")

    try:
        # 2. Write an HTML page
        print("\n2. Writing index.html...")
        html = """<!DOCTYPE html>
<html>
<head><title>OpenComputer Preview Test</title></head>
<body>
<h1>Hello from OpenComputer!</h1>
<p>Sandbox ID: %s</p>
<p>If you can see this, subdomain routing works.</p>
</body>
</html>""" % sb.sandbox_id
        await sb.files.write("/tmp/index.html", html)

        # 3. Start a simple HTTP server on port 80
        print("3. Starting HTTP server on port 80...")
        result = await sb.commands.run(
            "nohup python3 -m http.server 80 --directory /tmp > /dev/null 2>&1 & echo $!"
        )
        pid = result.stdout.strip()
        print(f"   Server PID: {pid}")

        # Give it a moment to start
        await asyncio.sleep(2)

        # 4. Verify server is running inside sandbox
        print("\n4. Verifying server inside sandbox...")
        result = await sb.commands.run("curl -s http://localhost:80/index.html")
        if "Hello from OpenComputer" in result.stdout:
            print("   \033[32m✓\033[0m Server responding inside sandbox")
        else:
            print("   \033[31m✗\033[0m Server not responding inside sandbox")
            print(f"   stdout: {result.stdout[:200]}")
            print(f"   stderr: {result.stderr[:200]}")

        # 5. Test via public domain
        print(f"\n5. Testing public URL: https://{sb.domain}/index.html")
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            try:
                resp = await client.get(f"https://{sb.domain}/index.html")
                if resp.status_code == 200 and "Hello from OpenComputer" in resp.text:
                    print(f"   \033[32m✓\033[0m Domain preview works! (HTTP {resp.status_code})")
                else:
                    print(f"   \033[31m✗\033[0m Unexpected response (HTTP {resp.status_code})")
                    print(f"   Body: {resp.text[:300]}")
            except Exception as e:
                print(f"   \033[31m✗\033[0m Request failed: {e}")

        # 6. Keep sandbox alive for manual testing
        print(f"\n{'='*50}")
        print(f"Preview URL: https://{sb.domain}/index.html")
        print(f"Sandbox ID:  {sb.sandbox_id}")
        print(f"Press Ctrl+C to kill the sandbox and exit.")
        print(f"{'='*50}")

        try:
            while True:
                await asyncio.sleep(5)
        except KeyboardInterrupt:
            print("\n\nShutting down...")

    except Exception as e:
        print(f"\n\033[31mERROR: {e}\033[0m")
        import traceback
        traceback.print_exc()

    finally:
        print("Killing sandbox...")
        try:
            await sb.kill()
        except Exception:
            pass
        await sb.close()
        print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
