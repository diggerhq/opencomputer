/**
 * Secrets Proxy Test
 *
 * Tests:
 *   1. Create a secret via the API
 *   2. Create a secret group linking the secret to an env var name
 *   3. Create a sandbox with that secret group attached
 *   4. Confirm the env var inside the sandbox shows a sealed token (osb_sealed_...), NOT the real value
 *   5. Confirm the sealed token is not the real value in any form
 *   6. Confirm the proxy substitutes the real value on outbound requests
 *      (uses httpbin.org/headers as an echo service)
 *   7. Egress allowlist blocks non-listed hosts
 *   8. Cleanup: delete secret group and secret
 *
 * Usage:
 *   npx tsx examples/test-secrets.ts
 */

import { Sandbox } from "../src/index";
import { randomBytes } from "crypto";

function green(msg: string) { console.log(`\x1b[32m\u2713 ${msg}\x1b[0m`); }
function red(msg: string) { console.log(`\x1b[31m\u2717 ${msg}\x1b[0m`); }
function bold(msg: string) { console.log(`\x1b[1m${msg}\x1b[0m`); }
function dim(msg: string) { console.log(`\x1b[2m  ${msg}\x1b[0m`); }

let passed = 0;
let failed = 0;

function check(desc: string, condition: boolean, detail?: string) {
  if (condition) {
    green(desc);
    passed++;
  } else {
    red(`${desc}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const apiKey = process.env.OPENSANDBOX_API_KEY ?? "";
  return fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
      ...opts.headers,
    },
  });
}

async function main() {
  bold("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  bold("\u2551       Secrets Proxy Test                          \u2551");
  bold("\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n");

  const apiUrl = (process.env.OPENSANDBOX_API_URL ?? "https://app.opensandbox.ai").replace(/\/+$/, "");
  const apiKey = process.env.OPENSANDBOX_API_KEY ?? "";
  if (!apiKey) {
    red("OPENSANDBOX_API_KEY is not set");
    process.exit(1);
  }

  const suffix = randomBytes(4).toString("hex");
  const secretName = `test-secret-${suffix}`;
  const groupName = `test-group-${suffix}`;
  const envVarName = "OSB_TEST_SECRET";
  const realValue = `sk-test-realvalue-${suffix}`;

  const apiBase = `${apiUrl}/api`;

  let secretId: string | null = null;
  let groupId: string | null = null;
  let sandbox: Sandbox | null = null;

  try {
    // ── Test 1: Create secret ──────────────────────────────────────────────
    bold("━━━ Test 1: Create secret ━━━\n");

    const createSecretResp = await apiFetch(`${apiBase}/secrets`, {
      method: "POST",
      body: JSON.stringify({
        name: secretName,
        description: "test secret for proxy verification",
        value: realValue,
      }),
    });
    check("Create secret returns 201", createSecretResp.status === 201,
      `got ${createSecretResp.status}: ${await createSecretResp.clone().text().then(t => t.slice(0, 100)).catch(() => "")}`);

    const secretData = await createSecretResp.json().catch(() => ({}));
    secretId = secretData.id;
    check("Secret has an ID", Boolean(secretId), JSON.stringify(secretData).slice(0, 80));
    check("Secret name matches", secretData.name === secretName, String(secretData.name));
    check("Response does NOT include the value", !("value" in secretData), Object.keys(secretData).join(", "));
    dim(`Secret: ${secretName} (id=${secretId})`);
    console.log();

    // ── Test 2: Create secret group ────────────────────────────────────────
    bold("━━━ Test 2: Create secret group ━━━\n");

    const createGroupResp = await apiFetch(`${apiBase}/secret-groups`, {
      method: "POST",
      body: JSON.stringify({
        name: groupName,
        description: "test group for proxy verification",
        allowedHosts: ["httpbin.org"],
        entries: [{ secretId, envVarName }],
      }),
    });
    check("Create secret group returns 201", createGroupResp.status === 201,
      `got ${createGroupResp.status}: ${await createGroupResp.clone().text().then(t => t.slice(0, 100)).catch(() => "")}`);

    const groupData = await createGroupResp.json().catch(() => ({}));
    groupId = groupData.id;
    check("Group has an ID", Boolean(groupId), JSON.stringify(groupData).slice(0, 80));
    check("Group name matches", groupData.name === groupName, String(groupData.name));
    dim(`Group: ${groupName} (id=${groupId})`);
    console.log();

    // ── Test 3: Create sandbox with secret group ───────────────────────────
    bold("━━━ Test 3: Create sandbox with secret group ━━━\n");

    sandbox = await Sandbox.create({
      template: "base",
      timeout: 120,
      secretGroupId: groupId!,
    });
    green(`Created sandbox: ${sandbox.sandboxId}`);
    console.log();

    // ── Test 4: Sealed token is injected (not the real value) ──────────────
    bold("━━━ Test 4: Sealed token injected ━━━\n");

    // Read from /etc/environment — canonical source
    const readEnv = await sandbox.commands.run(
      `grep '^${envVarName}=' /etc/environment | cut -d= -f2-`
    );
    const envValue = readEnv.stdout.trim().replace(/^['"]|['"]$/g, "");

    check("Env var is set in /etc/environment", Boolean(envValue), `exit=${readEnv.exitCode}`);
    check(
      "Env var is a sealed token (starts with osb_sealed_)",
      envValue.startsWith("osb_sealed_"),
      `got: ${envValue.slice(0, 60)}`,
    );
    check(
      "Real value NOT in /etc/environment",
      !readEnv.stdout.includes(realValue),
      `found real value in: ${readEnv.stdout.slice(0, 80)}`,
    );

    // Shell should also see the sealed token (not the real value)
    const shellEnv = await sandbox.commands.run(`bash -lc 'echo $${envVarName}'`);
    const shellValue = shellEnv.stdout.trim();
    check(
      "Shell sees sealed token (not real value)",
      shellValue.startsWith("osb_sealed_"),
      `got: ${shellValue.slice(0, 60)}`,
    );
    check(
      "Shell does NOT expose real value",
      !shellEnv.stdout.includes(realValue),
      "real value leaked into shell env",
    );

    const envDump = await sandbox.commands.run("env");
    check(
      "Full env dump does not contain real value",
      !envDump.stdout.includes(realValue),
      "real value found in env dump",
    );

    dim(`Sealed token: ${envValue}`);
    console.log();

    // ── Test 5: Proxy substitutes real value on outbound HTTPS ────────────
    bold("━━━ Test 5: Proxy substitutes on outbound HTTPS ━━━\n");

    // Send the sealed token as a header to httpbin.org/headers — it echoes all headers.
    // The proxy should replace the sealed token with the real value before forwarding.
    const curlCmd = `bash -lc 'curl -sf -H "x-osb-test: $${envVarName}" https://httpbin.org/headers'`;
    const curlResult = await sandbox.commands.run(curlCmd, { timeout: 30 });

    check("curl to httpbin.org succeeded", curlResult.exitCode === 0, curlResult.stderr.slice(0, 100));

    const responseBody = curlResult.stdout;
    check(
      "Response contains real value (proxy substituted the token)",
      responseBody.includes(realValue),
      `body snippet: ${responseBody.slice(0, 200)}`,
    );
    check(
      "Response does NOT contain the sealed token (proxy fully replaced it)",
      !responseBody.includes(envValue),
      `sealed token still present: ${envValue.slice(0, 30)}`,
    );

    dim(`httpbin response snippet: ${responseBody.slice(0, 150).trim()}`);
    console.log();

    // ── Test 6: Egress allowlist blocks non-listed hosts ──────────────────
    bold("━━━ Test 6: Egress allowlist blocks non-allowlisted host ━━━\n");

    const blockedCmd = `bash -lc 'curl -sf --max-time 10 https://example.com -o /dev/null -w "%{http_code}"'`;
    const blockedResult = await sandbox.commands.run(blockedCmd, { timeout: 20 });
    const blocked =
      blockedResult.exitCode !== 0 ||
      ["407", "403", "000"].includes(blockedResult.stdout.trim());
    check(
      "Non-allowlisted host is blocked by egress proxy",
      blocked,
      `exit=${blockedResult.exitCode}, stdout=${blockedResult.stdout.slice(0, 50)}`,
    );
    console.log();

    // ── Test 7: List and get operations ───────────────────────────────────
    bold("━━━ Test 7: List and get operations ━━━\n");

    const listResp = await apiFetch(`${apiBase}/secrets`);
    check("List secrets returns 200", listResp.status === 200, `got ${listResp.status}`);
    const secretsList: any[] = await listResp.json().catch(() => []);
    check("Created secret appears in list", secretsList.some(s => s.id === secretId),
      `ids: ${secretsList.slice(0, 3).map(s => s.id).join(", ")}`);
    check("List does NOT include values", secretsList.every(s => !("value" in s)), "value field leaked");

    const getGroupResp = await apiFetch(`${apiBase}/secret-groups/${groupId}`);
    check("Get secret group returns 200", getGroupResp.status === 200, `got ${getGroupResp.status}`);
    const groupDetail = await getGroupResp.json().catch(() => ({}));
    const entries: any[] = groupDetail.entries ?? [];
    check("Group has 1 entry", entries.length === 1, `got ${entries.length}`);
    check(
      "Entry has correct env var name",
      entries[0]?.envVarName === envVarName,
      JSON.stringify(entries.slice(0, 1)),
    );
    console.log();

  } catch (err: any) {
    red(`Fatal error: ${err.message || err}`);
    console.error(err);
    failed++;
  } finally {
    if (sandbox) {
      await sandbox.kill();
      green("Sandbox killed");
    }
    if (groupId) {
      await apiFetch(`${apiBase}/secret-groups/${groupId}`, { method: "DELETE" }).catch(() => {});
      green(`Secret group deleted: ${groupId}`);
    }
    if (secretId) {
      await apiFetch(`${apiBase}/secrets/${secretId}`, { method: "DELETE" }).catch(() => {});
      green(`Secret deleted: ${secretId}`);
    }
  }

  // ── Summary ──
  bold("========================================");
  bold(` Results: ${passed} passed, ${failed} failed`);
  bold("========================================\n");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
