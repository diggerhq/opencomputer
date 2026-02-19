/**
 * OpenSandbox SDK Lifecycle Test
 *
 * Tests: create → commands → files → domain → kill
 *
 * Usage:
 *   npx tsx examples/lifecycle-test.ts
 *
 * Environment:
 *   OPENSANDBOX_API_URL  (default: http://localhost:8080)
 *   OPENSANDBOX_API_KEY  (default: test-key)
 */

import { Sandbox } from "../src/index";

const API_URL = process.env.OPENSANDBOX_API_URL ?? "http://localhost:8080";
const API_KEY = process.env.OPENSANDBOX_API_KEY ?? "test-key";

function green(msg: string) { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }
function red(msg: string) { console.log(`\x1b[31m✗ ${msg}\x1b[0m`); }
function bold(msg: string) { console.log(`\x1b[1m${msg}\x1b[0m`); }
function dim(msg: string) { console.log(`\x1b[2m  ${msg}\x1b[0m`); }

let passed = 0;
let failed = 0;

function check(desc: string, expected: string, actual: string) {
  if (actual.includes(expected)) {
    green(desc);
    passed++;
  } else {
    red(`${desc} (expected '${expected}', got '${actual}')`);
    failed++;
  }
}

async function main() {
  bold("\n========================================");
  bold(" OpenSandbox TypeScript SDK Lifecycle");
  bold("========================================\n");
  dim(`API: ${API_URL}`);
  console.log();

  // --- Create ---
  bold("[1/7] Creating sandbox...");
  const sandbox = await Sandbox.create({
    template: "base",
    timeout: 300,
    apiKey: API_KEY,
    apiUrl: API_URL,
  });
  green(`Created: ${sandbox.sandboxId}`);
  check("Status is running", "running", sandbox.status);
  if (sandbox.domain) {
    dim(`Domain: ${sandbox.domain}`);
  }
  console.log();

  // --- Run commands ---
  bold("[2/7] Running commands...");
  const echo = await sandbox.commands.run("echo hello-world");
  check("Echo command", "hello-world", echo.stdout.trim());
  check("Exit code 0", "0", String(echo.exitCode));

  const uname = await sandbox.commands.run("uname -s");
  check("Uname returns Linux", "Linux", uname.stdout.trim());

  const multi = await sandbox.commands.run("echo line1 && echo line2 && echo line3");
  check("Multi-command", "line1", multi.stdout);
  check("Multi-command has line3", "line3", multi.stdout);
  console.log();

  // --- File operations ---
  bold("[3/7] File operations...");
  await sandbox.files.write("/tmp/test.txt", "hello from SDK");
  const content = await sandbox.files.read("/tmp/test.txt");
  check("Write and read file", "hello from SDK", content);

  await sandbox.files.makeDir("/tmp/mydir");
  await sandbox.files.write("/tmp/mydir/nested.txt", "nested content");
  const nested = await sandbox.files.read("/tmp/mydir/nested.txt");
  check("Nested file read", "nested content", nested);

  const entries = await sandbox.files.list("/tmp");
  check("List /tmp has test.txt", "test.txt", entries.map(e => e.name).join(","));

  const exists = await sandbox.files.exists("/tmp/test.txt");
  check("File exists", "true", String(exists));

  const notExists = await sandbox.files.exists("/tmp/nope.txt");
  check("File not exists", "false", String(notExists));
  console.log();

  // --- Environment variables ---
  bold("[4/7] Environment in commands...");
  const envResult = await sandbox.commands.run("echo $MY_VAR", { env: { MY_VAR: "secret-value" } });
  check("Env var passed to command", "secret-value", envResult.stdout.trim());
  console.log();

  // --- Working directory ---
  bold("[5/7] Working directory...");
  await sandbox.files.makeDir("/tmp/workdir");
  await sandbox.files.write("/tmp/workdir/data.txt", "workdir-data");
  const cwdResult = await sandbox.commands.run("cat data.txt", { cwd: "/tmp/workdir" });
  check("Working directory respected", "workdir-data", cwdResult.stdout.trim());
  console.log();

  // --- Domain / subdomain ---
  bold("[6/7] Subdomain domain...");
  if (sandbox.domain) {
    green(`Domain assigned: ${sandbox.domain}`);
  } else {
    dim("No domain assigned (OPENSANDBOX_SANDBOX_DOMAIN not configured on server)");
  }
  console.log();

  // --- isRunning + kill ---
  bold("[7/7] Lifecycle: isRunning → kill → isRunning...");
  const running1 = await sandbox.isRunning();
  check("isRunning before kill", "true", String(running1));

  await sandbox.kill();
  green("Sandbox killed");

  // Brief pause for state propagation
  await new Promise(r => globalThis.setTimeout(r, 500));

  const running2 = await sandbox.isRunning();
  check("isRunning after kill", "false", String(running2));
  console.log();

  // --- Summary ---
  bold("========================================");
  bold(` Results: ${passed} passed, ${failed} failed`);
  bold("========================================\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
