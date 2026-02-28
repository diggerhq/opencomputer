/**
 * OpenSandbox Secret Vault Demo
 *
 * Demonstrates the sealed-token secrets system:
 *   1. Create a secret (e.g., an API key)
 *   2. Create a secret group with egress allowlist
 *   3. Launch a sandbox with the secret group attached
 *   4. Show the sealed token inside the VM (real value never enters)
 *   5. Show proxy substitution on outbound HTTPS
 *   6. Show egress allowlist blocks non-listed hosts
 *
 * Usage:
 *   OPENCOMPUTER_API_URL=https://... OPENCOMPUTER_API_KEY=osb_... npx tsx demos/demo-secret-vault.ts
 */

import { Sandbox } from "../sdks/typescript/src/index";
import { randomBytes } from "crypto";

const green = (s: string) => console.log(`\x1b[32m✓ ${s}\x1b[0m`);
const red   = (s: string) => console.log(`\x1b[31m✗ ${s}\x1b[0m`);
const bold  = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);
const dim   = (s: string) => console.log(`\x1b[2m  ${s}\x1b[0m`);
const step  = (s: string) => bold(`\n━━━ ${s} ━━━\n`);

async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const apiUrl = (process.env.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev").replace(/\/+$/, "");
  const apiKey = process.env.OPENCOMPUTER_API_KEY ?? "";
  return fetch(`${apiUrl}/api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
      ...opts.headers,
    },
  });
}

async function main() {
  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║       Secret Vault Demo                          ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  const suffix = randomBytes(4).toString("hex");
  const secretName = `demo-api-key-${suffix}`;
  const groupName  = `demo-group-${suffix}`;
  const envVarName = "MY_API_KEY";
  const realValue  = `sk-live-${randomBytes(16).toString("hex")}`;

  let secretId: string | null = null;
  let groupId: string | null = null;
  let sandbox: Sandbox | null = null;

  try {
    // ── 1. Create a secret ──────────────────────────────────────
    step("1. Create a secret");

    dim(`Secret name: ${secretName}`);
    dim(`Real value:  ${realValue.slice(0, 20)}...`);

    const secretResp = await apiFetch("/secrets", {
      method: "POST",
      body: JSON.stringify({
        name: secretName,
        description: "Demo API key for secret vault showcase",
        value: realValue,
      }),
    });
    const secretData = await secretResp.json();
    secretId = secretData.id;
    green(`Secret created (id=${secretId})`);
    dim("Note: the API response does NOT include the value — it's encrypted at rest");

    // ── 2. Create a secret group with egress allowlist ──────────
    step("2. Create a secret group");

    dim(`Group name: ${groupName}`);
    dim(`Mapping: ${envVarName} → ${secretName}`);
    dim(`Allowed hosts: httpbin.org`);

    const groupResp = await apiFetch("/secret-groups", {
      method: "POST",
      body: JSON.stringify({
        name: groupName,
        description: "Demo group — allows outbound to httpbin.org only",
        allowedHosts: ["httpbin.org"],
        entries: [{ secretId, envVarName }],
      }),
    });
    const groupData = await groupResp.json();
    groupId = groupData.id;
    green(`Secret group created (id=${groupId})`);

    // ── 3. Launch sandbox with secret group ─────────────────────
    step("3. Launch sandbox with secret group attached");

    sandbox = await Sandbox.create({
      template: "base",
      timeout: 120,
      secretGroupId: groupId!,
    });
    green(`Sandbox created: ${sandbox.sandboxId}`);

    // ── 4. Show sealed token inside the VM ──────────────────────
    step("4. Inspect the environment inside the VM");

    const envResult = await sandbox.commands.run(
      `grep '^${envVarName}=' /etc/environment | cut -d= -f2-`
    );
    const sealedToken = envResult.stdout.trim().replace(/^['"]|['"]$/g, "");

    dim(`$${envVarName} = ${sealedToken}`);

    if (sealedToken.startsWith("osb_sealed_")) {
      green("Environment variable is a sealed token (osb_sealed_...) — NOT the real value");
    } else {
      red(`Expected sealed token, got: ${sealedToken}`);
    }

    if (!sealedToken.includes(realValue)) {
      green("Real secret value is NOT visible inside the VM");
    } else {
      red("Real value leaked into the VM!");
    }

    // ── 5. Show proxy substitution on outbound HTTPS ────────────
    step("5. Outbound HTTPS — proxy substitutes the real value");

    dim(`Sending sealed token as header to httpbin.org/headers...`);

    const curlResult = await sandbox.commands.run(
      `curl -sf -H "x-api-key: ${sealedToken}" https://httpbin.org/headers`,
      { timeout: 30 }
    );

    if (curlResult.exitCode === 0) {
      green("curl to httpbin.org succeeded");

      if (curlResult.stdout.includes(realValue)) {
        green("httpbin received the REAL value — proxy substituted the sealed token!");
      } else {
        red("httpbin did not receive the real value");
      }

      if (!curlResult.stdout.includes(sealedToken)) {
        green("Sealed token was fully replaced — never reached the external server");
      } else {
        red("Sealed token leaked to external server");
      }
    } else {
      red(`curl failed: ${curlResult.stderr}`);
    }

    // ── 6. Egress allowlist ─────────────────────────────────────
    step("6. Egress allowlist — non-allowed hosts are blocked");

    dim("Trying to reach example.com (not in allowedHosts)...");
    const blockedResult = await sandbox.commands.run(
      `curl -sf --max-time 10 https://example.com -o /dev/null -w "%{http_code}" 2>&1 || echo "BLOCKED"`,
      { timeout: 20 }
    );

    const blocked =
      blockedResult.exitCode !== 0 ||
      blockedResult.stdout.includes("BLOCKED") ||
      ["407", "403", "000"].includes(blockedResult.stdout.trim());

    if (blocked) {
      green("Non-allowed host was blocked by egress proxy");
    } else {
      red(`Expected block, got: ${blockedResult.stdout.trim()}`);
    }

  } catch (err: any) {
    red(`Error: ${err.message}`);
    console.error(err);
  } finally {
    step("Cleanup");

    if (sandbox) {
      await sandbox.kill();
      green("Sandbox killed");
    }
    if (groupId) {
      await apiFetch(`/secret-groups/${groupId}`, { method: "DELETE" });
      green("Secret group deleted");
    }
    if (secretId) {
      await apiFetch(`/secrets/${secretId}`, { method: "DELETE" });
      green("Secret deleted");
    }
  }

  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║  \x1b[32mSecret Vault Demo Complete!\x1b[0m\x1b[1m                    ║");
  bold("╚══════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
