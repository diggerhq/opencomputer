#!/usr/bin/env python3
"""
Secrets Proxy Test

Tests:
  1. Create a secret via the API
  2. Create a secret group linking the secret to an env var name
  3. Create a sandbox with that secret group attached
  4. Confirm the env var inside the sandbox shows a sealed token (osb_sealed_...), NOT the real value
  5. Confirm the sealed token is not the real value in any form
  6. Confirm the proxy substitutes the real value on outbound requests
     (uses httpbin.org/headers as an echo service — sends sealed token as a header,
      checks the response shows the real value, proving the proxy did the swap)
  7. Cleanup: delete secret group, delete secret

Usage:
  python examples/test_secrets.py
"""

import asyncio
import os
import sys
import uuid

import httpx

from opensandbox import Sandbox

GREEN = "\033[32m"
RED = "\033[31m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

passed = 0
failed = 0


def green(msg: str) -> None:
    print(f"{GREEN}\u2713 {msg}{RESET}")


def red(msg: str) -> None:
    print(f"{RED}\u2717 {msg}{RESET}")


def bold(msg: str) -> None:
    print(f"{BOLD}{msg}{RESET}")


def dim(msg: str) -> None:
    print(f"{DIM}  {msg}{RESET}")


def check(desc: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        green(desc)
        passed += 1
    else:
        red(f"{desc} ({detail})" if detail else desc)
        failed += 1


async def main() -> None:
    global passed, failed

    bold("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557")
    bold("\u2551       Secrets Proxy Test                          \u2551")
    bold("\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n")

    api_url = os.environ.get("OPENSANDBOX_API_URL", "https://app.opensandbox.ai").rstrip("/")
    api_key = os.environ.get("OPENSANDBOX_API_KEY", "")
    if not api_key:
        red("OPENSANDBOX_API_KEY is not set")
        sys.exit(1)

    # Use a unique suffix so parallel test runs don't collide
    suffix = uuid.uuid4().hex[:8]
    secret_name = f"test-secret-{suffix}"
    group_name = f"test-group-{suffix}"
    env_var_name = "OSB_TEST_SECRET"
    # A realistic-looking fake API key — distinct enough to verify substitution
    real_value = f"sk-test-realvalue-{suffix}"

    api_base = f"{api_url}/api"
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}

    secret_id: str | None = None
    group_id: str | None = None
    sandbox: Sandbox | None = None

    async with httpx.AsyncClient(timeout=30) as http:
        try:
            # ── Test 1: Create secret ─────────────────────────────────────────
            bold("━━━ Test 1: Create secret ━━━\n")

            resp = await http.post(
                f"{api_base}/secrets",
                headers=headers,
                json={"name": secret_name, "description": "test secret for proxy verification", "value": real_value},
            )
            check("Create secret returns 201", resp.status_code == 201, f"got {resp.status_code}: {resp.text[:100]}")

            secret_data = resp.json()
            secret_id = secret_data.get("id")
            check("Secret has an ID", bool(secret_id), str(secret_data)[:80])
            check("Secret name matches", secret_data.get("name") == secret_name, str(secret_data.get("name")))
            check("Response does NOT include the value", "value" not in secret_data, str(list(secret_data.keys())))
            dim(f"Secret: {secret_name} (id={secret_id})")
            print()

            # ── Test 2: Create secret group ───────────────────────────────────
            bold("━━━ Test 2: Create secret group ━━━\n")

            resp = await http.post(
                f"{api_base}/secret-groups",
                headers=headers,
                json={
                    "name": group_name,
                    "description": "test group for proxy verification",
                    "allowedHosts": ["httpbin.org"],  # restrict to just httpbin for egress test
                    "entries": [{"secretId": secret_id, "envVarName": env_var_name}],
                },
            )
            check("Create secret group returns 201", resp.status_code == 201, f"got {resp.status_code}: {resp.text[:100]}")

            group_data = resp.json()
            group_id = group_data.get("id")
            check("Group has an ID", bool(group_id), str(group_data)[:80])
            check("Group name matches", group_data.get("name") == group_name, str(group_data.get("name")))
            dim(f"Group: {group_name} (id={group_id})")
            print()

            # ── Test 3: Create sandbox with secret group ──────────────────────
            bold("━━━ Test 3: Create sandbox with secret group ━━━\n")

            sandbox = await Sandbox.create(
                template="base",
                timeout=120,
                secret_group_id=group_id,
            )
            green(f"Created sandbox: {sandbox.sandbox_id}")
            print()

            # ── Test 4: Sealed token is injected (not the real value) ─────────
            bold("━━━ Test 4: Sealed token injected ━━━\n")

            # Read the env var from /etc/environment (source of truth)
            read_env = await sandbox.commands.run(
                f"grep '^{env_var_name}=' /etc/environment | cut -d= -f2-"
            )
            env_value = read_env.stdout.strip().strip("'\"")

            check("Env var is set in /etc/environment", bool(env_value), f"exit={read_env.exit_code}")
            check(
                "Env var is a sealed token (starts with osb_sealed_)",
                env_value.startswith("osb_sealed_"),
                f"got: {env_value[:60]}",
            )
            check(
                "Real value NOT in /etc/environment",
                real_value not in read_env.stdout,
                f"found real value in: {read_env.stdout[:80]}",
            )

            # Also check via shell — login shell sources /etc/environment
            shell_env = await sandbox.commands.run(f"bash -lc 'echo ${env_var_name}'")
            shell_value = shell_env.stdout.strip()
            check(
                "Shell sees sealed token (not real value)",
                shell_value.startswith("osb_sealed_"),
                f"got: {shell_value[:60]}",
            )
            check(
                "Shell does NOT expose real value",
                real_value not in shell_env.stdout,
                "real value leaked into shell env",
            )

            # env dump should never show the real value
            env_dump = await sandbox.commands.run("env")
            check(
                "Full env dump does not contain real value",
                real_value not in env_dump.stdout,
                "real value found in env dump",
            )

            dim(f"Sealed token: {env_value}")
            print()

            # ── Test 5: Proxy substitutes real value on outbound request ──────
            bold("━━━ Test 5: Proxy substitutes on outbound HTTPS ━━━\n")

            # Send the sealed token as an HTTP header to httpbin.org/headers
            # httpbin echoes all request headers in the response body.
            # If the proxy is working, the echoed value will be the REAL value, not the sealed token.
            curl_cmd = (
                f"bash -lc 'curl -sf "
                f"-H \"x-osb-test: ${env_var_name}\" "
                f"https://httpbin.org/headers'"
            )
            curl_result = await sandbox.commands.run(curl_cmd, timeout=30)

            check("curl to httpbin.org succeeded", curl_result.exit_code == 0, curl_result.stderr[:100])

            response_body = curl_result.stdout
            check(
                "Response contains real value (proxy substituted the token)",
                real_value in response_body,
                f"body snippet: {response_body[:200]}",
            )
            check(
                "Response does NOT contain the sealed token (proxy fully replaced it)",
                env_value not in response_body,
                f"sealed token still present in response: {env_value[:30]}",
            )

            dim(f"httpbin response snippet: {response_body[:150].strip()}")
            print()

            # ── Test 6: Egress allowlist blocks other hosts ───────────────────
            bold("━━━ Test 6: Egress allowlist blocks non-allowlisted host ━━━\n")

            # The group was created with allowedHosts=["httpbin.org"]
            # Attempting to reach a different host should be blocked by the proxy (407)
            blocked_cmd = (
                "bash -lc 'curl -sf --max-time 10 https://example.com -o /dev/null -w \"%{http_code}\"'"
            )
            blocked_result = await sandbox.commands.run(blocked_cmd, timeout=20)
            # curl exits non-zero on 407, or we check the status code
            blocked = (
                blocked_result.exit_code != 0
                or "407" in blocked_result.stdout
                or "403" in blocked_result.stdout
                or blocked_result.stdout.strip() in ("407", "403", "000")
            )
            check(
                "Non-allowlisted host is blocked by egress proxy",
                blocked,
                f"exit={blocked_result.exit_code}, stdout={blocked_result.stdout[:50]}, stderr={blocked_result.stderr[:50]}",
            )
            print()

            # ── Test 7: List and get group ────────────────────────────────────
            bold("━━━ Test 7: List and get operations ━━━\n")

            list_resp = await http.get(f"{api_base}/secrets", headers=headers)
            check("List secrets returns 200", list_resp.status_code == 200, f"got {list_resp.status_code}")
            secrets_list = list_resp.json()
            found = any(s.get("id") == secret_id for s in secrets_list)
            check("Created secret appears in list", found, f"ids: {[s.get('id') for s in secrets_list][:3]}")
            check("List does NOT include values", all("value" not in s for s in secrets_list), "value field leaked")

            get_group_resp = await http.get(f"{api_base}/secret-groups/{group_id}", headers=headers)
            check("Get secret group returns 200", get_group_resp.status_code == 200, f"got {get_group_resp.status_code}")
            group_detail = get_group_resp.json()
            entries = group_detail.get("entries", [])
            check("Group has 1 entry", len(entries) == 1, f"got {len(entries)}")
            check(
                "Entry has correct env var name",
                entries[0].get("envVarName") == env_var_name if entries else False,
                str(entries[:1]),
            )
            print()

        except Exception as e:
            red(f"Fatal error: {e}")
            import traceback
            traceback.print_exc()
            failed += 1

        finally:
            # Cleanup
            if sandbox:
                await sandbox.kill()
                green("Sandbox killed")
            if group_id:
                try:
                    await http.delete(f"{api_base}/secret-groups/{group_id}", headers=headers)
                    green(f"Secret group deleted: {group_id}")
                except Exception:
                    pass
            if secret_id:
                try:
                    await http.delete(f"{api_base}/secrets/{secret_id}", headers=headers)
                    green(f"Secret deleted: {secret_id}")
                except Exception:
                    pass

    # ── Summary ──
    bold("========================================")
    bold(f" Results: {passed} passed, {failed} failed")
    bold("========================================\n")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
