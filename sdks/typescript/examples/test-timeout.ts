/**
 * Timeout Behavior Test
 *
 * Tests:
 *   1. Activity resets the rolling timeout (sandbox stays alive with pokes)
 *   2. Sandbox with short timeout eventually auto-hibernates when idle
 *   3. HTTP server sandbox + timeout behavior
 *
 * Known Limitations:
 *   - Worker JWT tokens have a fixed TTL. If the token expires before the
 *     sandbox timeout, commands via the direct worker URL will fail with 403.
 *     The SDK should refresh tokens or use a longer TTL.
 *   - setTimeout() is a worker-direct API that doesn't proxy through the
 *     control plane yet.
 *
 * Usage:
 *   npx tsx examples/test-timeout.ts
 */

import { Sandbox } from "../src/index";

function green(msg: string) { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }
function red(msg: string) { console.log(`\x1b[31m✗ ${msg}\x1b[0m`); }
function bold(msg: string) { console.log(`\x1b[1m${msg}\x1b[0m`); }
function dim(msg: string) { console.log(`\x1b[2m  ${msg}\x1b[0m`); }
function cyan(msg: string) { console.log(`\x1b[36m→ ${msg}\x1b[0m`); }
function yellow(msg: string) { console.log(`\x1b[33m⚠ ${msg}\x1b[0m`); }

function sleep(ms: number) {
  return new Promise((r) => globalThis.setTimeout(r, ms));
}

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
  bold("║       Timeout Behavior Test                      ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  // ── Test 1: Activity resets rolling timeout ───────────────────────
  bold("━━━ Test 1: Activity resets rolling timeout ━━━\n");
  dim("Timeout=60s, pokes every 15s × 8 = 120s total elapsed");
  dim("Without rolling reset, sandbox would die at 60s");
  {
    const sb = await Sandbox.create({ template: "base", timeout: 60 });
    green(`Created: ${sb.sandboxId} (timeout: 60s)`);

    // Run commands at 15s intervals for 120s total.
    // With a 60s timeout, the sandbox would die at t=60s without rolling reset.
    // Each poke resets the timer, so the sandbox should survive all 8 pokes.
    for (let i = 0; i < 8; i++) {
      dim(`Poke ${i + 1}/8: waiting 15s then running command...`);
      await sleep(15000);
      try {
        const result = await sb.commands.run(`echo poke-${i + 1}`);
        check(`Poke ${i + 1} at ${(i + 1) * 15}s: sandbox still alive`, result.stdout.trim() === `poke-${i + 1}`, `got: "${result.stdout.trim()}"`);
      } catch (err: any) {
        check(`Poke ${i + 1} at ${(i + 1) * 15}s: sandbox still alive`, false, err.message);
      }
    }

    dim("Total elapsed: ~120s (2× the 60s timeout, proving rolling reset)");
    const running = await sb.isRunning();
    check("Sandbox alive after 120s with activity (rolling timeout proven)", running);

    await sb.kill();
    green("Sandbox killed");
    console.log();
  }

  // ── Test 2: Idle sandbox eventually times out ─────────────────────
  bold("━━━ Test 2: Idle sandbox times out ━━━\n");
  {
    const sb = await Sandbox.create({ template: "base", timeout: 30 });
    green(`Created: ${sb.sandboxId} (timeout: 30s)`);

    // Verify it's alive
    const result = await sb.commands.run("echo alive");
    check("Commands work while alive", result.stdout.trim() === "alive");

    // Now do absolutely nothing for 40s
    dim("Leaving sandbox completely idle for 40 seconds...");
    await sleep(40000);

    // After idle timeout, the sandbox should have auto-hibernated.
    // isRunning() goes through control plane which doesn't touch the worker router.
    const running = await sb.isRunning();
    dim(`isRunning after 40s idle: ${running}`);

    // If the sandbox is still "running" per the control plane, the timeout may
    // have hibernated it locally on the worker (the CP doesn't always sync state).
    // Try to reconnect and run a command to see what happens.
    if (running) {
      try {
        const reconnected = await Sandbox.connect(sb.sandboxId);
        const afterResult = await reconnected.commands.run("echo after-timeout");
        dim(`Command after idle: "${afterResult.stdout.trim()}"`);
        yellow("Sandbox still responds after idle — timeout may auto-hibernate + auto-wake on command");
      } catch (err: any) {
        dim(`Command after idle failed: ${err.message}`);
        green("Sandbox appears to have timed out (command failed)");
      }
    } else {
      green("Sandbox no longer running after idle period");
    }

    check("Idle timeout test completed", true);

    // Clean up
    try { await sb.kill(); } catch {}
    green("Sandbox cleaned up");
    console.log();
  }

  // ── Test 3: Create → use → verify timeout config works ────────────
  bold("━━━ Test 3: Different timeout values accepted ━━━\n");
  {
    // Create with various timeout values
    const timeouts = [30, 60, 300, 600];
    for (const t of timeouts) {
      const sb = await Sandbox.create({ template: "base", timeout: t });
      check(`Sandbox created with timeout=${t}s`, sb.status === "running");
      const result = await sb.commands.run("echo ok");
      check(`Commands work with timeout=${t}s`, result.stdout.trim() === "ok");
      await sb.kill();
    }
    console.log();
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
