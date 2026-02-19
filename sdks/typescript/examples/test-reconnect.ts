/**
 * SDK Connect/Reconnect Test
 *
 * Tests:
 *   1. Create sandbox, disconnect, reconnect via Sandbox.connect()
 *   2. Verify state persists across connections
 *   3. Multiple connect() calls to same sandbox
 *   4. Operations work on reconnected instance
 *
 * Usage:
 *   npx tsx examples/test-reconnect.ts
 */

import { Sandbox } from "../src/index";

function green(msg: string) { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }
function red(msg: string) { console.log(`\x1b[31m✗ ${msg}\x1b[0m`); }
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

async function main() {
  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║       SDK Connect/Reconnect Test                 ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  let sandboxId = "";

  try {
    // ── Test 1: Create and store ID ─────────────────────────────────
    bold("━━━ Test 1: Create sandbox and store ID ━━━\n");

    const original = await Sandbox.create({ template: "base", timeout: 120 });
    sandboxId = original.sandboxId;
    green(`Created: ${sandboxId}`);
    dim(`Domain: ${original.domain}`);

    // Write state
    await original.files.write("/tmp/reconnect-test.txt", "original-data");
    await original.commands.run("echo 'state-marker' > /tmp/marker.txt");
    green("State written to sandbox");
    console.log();

    // ── Test 2: Reconnect via Sandbox.connect() ─────────────────────
    bold("━━━ Test 2: Reconnect via Sandbox.connect() ━━━\n");

    const reconnected = await Sandbox.connect(sandboxId);
    check("Reconnect succeeded", !!reconnected);
    check("Same sandbox ID", reconnected.sandboxId === sandboxId);
    check("Domain matches", reconnected.domain === original.domain, reconnected.domain);
    check("Status is running", reconnected.status === "running", reconnected.status);
    console.log();

    // ── Test 3: Read state from reconnected instance ────────────────
    bold("━━━ Test 3: State persists across connections ━━━\n");

    const fileContent = await reconnected.files.read("/tmp/reconnect-test.txt");
    check("File from original instance readable", fileContent === "original-data", fileContent);

    const markerContent = await reconnected.files.read("/tmp/marker.txt");
    check("Command output file persisted", markerContent.trim() === "state-marker");

    // Write new data from reconnected instance
    await reconnected.files.write("/tmp/reconnect-new.txt", "from-reconnected");
    const newContent = await reconnected.files.read("/tmp/reconnect-new.txt");
    check("Write from reconnected instance works", newContent === "from-reconnected");
    console.log();

    // ── Test 4: Commands work on reconnected instance ───────────────
    bold("━━━ Test 4: Commands work on reconnected instance ━━━\n");

    const echo = await reconnected.commands.run("echo reconnected-echo");
    check("Echo command works", echo.stdout.trim() === "reconnected-echo");
    check("Exit code is 0", echo.exitCode === 0);

    const uname = await reconnected.commands.run("uname -s");
    check("Uname returns Linux", uname.stdout.trim() === "Linux");

    // Env vars
    const envResult = await reconnected.commands.run("echo $TEST_VAR", {
      env: { TEST_VAR: "reconnected-env" },
    });
    check("Env vars work on reconnected instance", envResult.stdout.trim() === "reconnected-env");

    // File list
    const entries = await reconnected.files.list("/tmp");
    check("File listing works", entries.some(e => e.name === "reconnect-test.txt"));
    check("New file visible in listing", entries.some(e => e.name === "reconnect-new.txt"));
    console.log();

    // ── Test 5: Multiple simultaneous connections ───────────────────
    bold("━━━ Test 5: Multiple simultaneous connections ━━━\n");

    const conn1 = await Sandbox.connect(sandboxId);
    const conn2 = await Sandbox.connect(sandboxId);
    const conn3 = await Sandbox.connect(sandboxId);

    check("3 connections to same sandbox succeeded", !!conn1 && !!conn2 && !!conn3);

    // All should be able to read
    const [read1, read2, read3] = await Promise.all([
      conn1.files.read("/tmp/reconnect-test.txt"),
      conn2.files.read("/tmp/reconnect-test.txt"),
      conn3.files.read("/tmp/reconnect-test.txt"),
    ]);

    check("All connections read same data",
      read1 === "original-data" && read2 === "original-data" && read3 === "original-data");

    // Write from conn1, read from conn2
    await conn1.files.write("/tmp/cross-conn.txt", "from-conn1");
    const crossRead = await conn2.files.read("/tmp/cross-conn.txt");
    check("Write from conn1 visible to conn2", crossRead === "from-conn1");
    console.log();

    // ── Test 6: isRunning on reconnected instance ───────────────────
    bold("━━━ Test 6: isRunning on reconnected instance ━━━\n");

    const running = await reconnected.isRunning();
    check("isRunning returns true", running);
    console.log();

    // ── Test 7: Kill from reconnected instance ──────────────────────
    bold("━━━ Test 7: Kill from reconnected instance ━━━\n");

    await reconnected.kill();
    green("Killed from reconnected instance");

    await new Promise(r => globalThis.setTimeout(r, 500));

    // Verify from original reference
    const stillRunning = await original.isRunning();
    check("Original ref sees sandbox as stopped", !stillRunning);

    // Verify connect fails for killed sandbox
    try {
      const deadConn = await Sandbox.connect(sandboxId);
      const deadRunning = await deadConn.isRunning();
      check("Connect to killed sandbox: isRunning=false", !deadRunning);
    } catch (err: any) {
      check("Connect to killed sandbox: throws or returns not running", true);
      dim(`Error: ${err.message}`);
    }
    console.log();

    // Clear sandboxId so cleanup doesn't try to kill again
    sandboxId = "";

  } catch (err: any) {
    red(`Fatal error: ${err.message}`);
    if (err.stack) dim(err.stack);
    failed++;
  } finally {
    if (sandboxId) {
      try {
        const cleanup = await Sandbox.connect(sandboxId);
        await cleanup.kill();
        green("Sandbox killed in cleanup");
      } catch {}
    }
  }

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
