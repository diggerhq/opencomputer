/**
 * Concurrent Sandbox Test
 *
 * Tests:
 *   1. Create 5 sandboxes simultaneously
 *   2. Run commands on all in parallel
 *   3. Verify each sandbox is isolated
 *   4. Kill all in parallel
 *
 * Usage:
 *   npx tsx examples/test-concurrent.ts
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

const SANDBOX_COUNT = 5;

async function main() {
  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║       Concurrent Sandbox Test                    ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  const sandboxes: Sandbox[] = [];

  try {
    // ── Test 1: Create N sandboxes simultaneously ───────────────────
    bold(`━━━ Test 1: Create ${SANDBOX_COUNT} sandboxes simultaneously ━━━\n`);

    const createStart = Date.now();
    const createPromises = Array.from({ length: SANDBOX_COUNT }, (_, i) =>
      Sandbox.create({ template: "base", timeout: 120 })
        .then((sb) => {
          dim(`Sandbox ${i + 1}: ${sb.sandboxId} (${sb.domain})`);
          return sb;
        }),
    );

    const results = await Promise.allSettled(createPromises);
    const createMs = Date.now() - createStart;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        sandboxes.push(r.value);
        check(`Sandbox ${i + 1} created`, true);
      } else {
        check(`Sandbox ${i + 1} created`, false, r.reason.message);
      }
    }
    dim(`Total create time: ${createMs}ms (${(createMs / SANDBOX_COUNT).toFixed(0)}ms avg)`);
    console.log();

    // ── Test 2: Run commands on all in parallel ─────────────────────
    bold("━━━ Test 2: Run commands on all sandboxes in parallel ━━━\n");

    const cmdStart = Date.now();
    const cmdPromises = sandboxes.map((sb, i) =>
      sb.commands.run(`echo "sandbox-${i}-${sb.sandboxId}"`).then((r) => ({
        index: i,
        id: sb.sandboxId,
        result: r,
      })),
    );

    const cmdResults = await Promise.allSettled(cmdPromises);
    const cmdMs = Date.now() - cmdStart;

    for (const r of cmdResults) {
      if (r.status === "fulfilled") {
        const { index, id, result } = r.value;
        const expected = `sandbox-${index}-${id}`;
        check(
          `Sandbox ${index + 1} echo correct`,
          result.stdout.trim() === expected,
          result.stdout.trim(),
        );
      } else {
        check("Command execution", false, r.reason.message);
      }
    }
    dim(`Total command time: ${cmdMs}ms`);
    console.log();

    // ── Test 3: Verify isolation ────────────────────────────────────
    bold("━━━ Test 3: Verify sandbox isolation ━━━\n");

    // Write a unique file to each sandbox
    const writePromises = sandboxes.map((sb, i) =>
      sb.files.write("/tmp/identity.txt", `sandbox-${i}`),
    );
    await Promise.all(writePromises);

    // Read back from each — should only see its own identity
    const readPromises = sandboxes.map((sb, i) =>
      sb.files.read("/tmp/identity.txt").then((content) => ({
        index: i,
        content,
      })),
    );

    const readResults = await Promise.all(readPromises);
    for (const { index, content } of readResults) {
      check(
        `Sandbox ${index + 1} sees only its own data`,
        content === `sandbox-${index}`,
        content,
      );
    }

    // Verify PID namespaces are isolated
    const pidPromises = sandboxes.map((sb, i) =>
      sb.commands.run("echo $$").then((r) => ({
        index: i,
        pid: r.stdout.trim(),
      })),
    );

    const pidResults = await Promise.all(pidPromises);
    // In isolated PID namespaces, PIDs should be low numbers
    for (const { index, pid } of pidResults) {
      dim(`Sandbox ${index + 1} shell PID: ${pid}`);
    }
    // Check that they all have independent PID spaces (PIDs should be same or similar low numbers)
    const uniquePids = new Set(pidResults.map((r) => r.pid));
    // With PID namespaces, most will have the same low PID number
    check(
      "PID namespace isolation (low PIDs)",
      pidResults.every((r) => parseInt(r.pid) < 1000),
      `PIDs: ${pidResults.map((r) => r.pid).join(", ")}`,
    );
    console.log();

    // ── Test 4: Parallel file operations ────────────────────────────
    bold("━━━ Test 4: Parallel file operations across sandboxes ━━━\n");

    // Each sandbox creates 10 files and reads them back
    const fileOpPromises = sandboxes.map(async (sb, i) => {
      const writes = Array.from({ length: 10 }, (_, j) =>
        sb.files.write(`/tmp/file-${j}.txt`, `sb${i}-file${j}`),
      );
      await Promise.all(writes);

      const reads = Array.from({ length: 10 }, (_, j) =>
        sb.files.read(`/tmp/file-${j}.txt`),
      );
      const contents = await Promise.all(reads);

      return {
        index: i,
        allCorrect: contents.every((c, j) => c === `sb${i}-file${j}`),
        count: contents.length,
      };
    });

    const fileResults = await Promise.all(fileOpPromises);
    for (const { index, allCorrect, count } of fileResults) {
      check(
        `Sandbox ${index + 1}: ${count} files written and verified`,
        allCorrect,
      );
    }
    console.log();

    // ── Test 5: List all sandboxes (API check) ──────────────────────
    bold("━━━ Test 5: Verify all sandboxes visible via API ━━━\n");

    // Use isRunning to verify all are still up
    const statusPromises = sandboxes.map((sb, i) =>
      sb.isRunning().then((running) => ({ index: i, running })),
    );
    const statuses = await Promise.all(statusPromises);
    for (const { index, running } of statuses) {
      check(`Sandbox ${index + 1} still running`, running);
    }
    console.log();

    // ── Test 6: Kill all in parallel ────────────────────────────────
    bold(`━━━ Test 6: Kill all ${SANDBOX_COUNT} sandboxes simultaneously ━━━\n`);

    const killStart = Date.now();
    const killPromises = sandboxes.map((sb, i) =>
      sb.kill().then(() => ({ index: i, success: true }))
        .catch((err) => ({ index: i, success: false, error: err.message })),
    );

    const killResults = await Promise.all(killPromises);
    const killMs = Date.now() - killStart;

    for (const r of killResults) {
      check(`Sandbox ${r.index + 1} killed`, r.success, (r as any).error);
    }
    dim(`Total kill time: ${killMs}ms`);

    // Verify they're all gone
    await new Promise((r) => globalThis.setTimeout(r, 1000));
    const postKillPromises = sandboxes.map((sb, i) =>
      sb.isRunning().then((running) => ({ index: i, running })),
    );
    const postKill = await Promise.all(postKillPromises);
    for (const { index, running } of postKill) {
      check(`Sandbox ${index + 1} confirmed stopped`, !running);
    }
    console.log();

  } catch (err: any) {
    red(`Fatal error: ${err.message}`);
    failed++;
    // Kill any sandboxes that were created
    for (const sb of sandboxes) {
      try { await sb.kill(); } catch {}
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
