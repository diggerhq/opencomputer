/**
 * Command Edge Cases Test
 *
 * Tests:
 *   1. Long-running command with timeout
 *   2. Command that writes to stderr
 *   3. Non-zero exit codes
 *   4. Large stdout output
 *   5. Environment variable passing
 *   6. Working directory
 *   7. Pipe and shell features
 *   8. Concurrent commands on same sandbox
 *
 * Usage:
 *   npx tsx examples/test-commands.ts
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
  bold("║       Command Edge Cases Test                    ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  let sandbox: Sandbox | null = null;

  try {
    sandbox = await Sandbox.create({ template: "base", timeout: 120 });
    green(`Created sandbox: ${sandbox.sandboxId}`);
    console.log();

    // ── Test 1: Basic command ───────────────────────────────────────
    bold("━━━ Test 1: Basic commands ━━━\n");

    const echo = await sandbox.commands.run("echo hello-world");
    check("Echo returns correct output", echo.stdout.trim() === "hello-world");
    check("Echo exit code is 0", echo.exitCode === 0);

    const multi = await sandbox.commands.run("echo line1 && echo line2 && echo line3");
    const lines = multi.stdout.trim().split("\n");
    check("Multi-command outputs 3 lines", lines.length === 3);
    check("Multi-command content correct", lines[0] === "line1" && lines[2] === "line3");
    console.log();

    // ── Test 2: stderr handling ─────────────────────────────────────
    bold("━━━ Test 2: stderr handling ━━━\n");

    const stderrCmd = await sandbox.commands.run("echo error-msg >&2");
    check("stderr captured", stderrCmd.stderr.trim() === "error-msg");
    check("stdout empty when writing to stderr", stderrCmd.stdout.trim() === "");
    check("Exit code 0 even with stderr", stderrCmd.exitCode === 0);

    // Mixed stdout + stderr
    const mixed = await sandbox.commands.run("echo stdout-data && echo stderr-data >&2");
    check("Mixed: stdout captured", mixed.stdout.includes("stdout-data"));
    check("Mixed: stderr captured", mixed.stderr.includes("stderr-data"));
    console.log();

    // ── Test 3: Non-zero exit codes ─────────────────────────────────
    bold("━━━ Test 3: Non-zero exit codes ━━━\n");

    const exit1 = await sandbox.commands.run("exit 1");
    check("Exit code 1 captured", exit1.exitCode === 1, `got ${exit1.exitCode}`);

    const exit42 = await sandbox.commands.run("exit 42");
    check("Exit code 42 captured", exit42.exitCode === 42, `got ${exit42.exitCode}`);

    const falseCmd = await sandbox.commands.run("false");
    check("'false' returns exit code 1", falseCmd.exitCode === 1, `got ${falseCmd.exitCode}`);

    const notFound = await sandbox.commands.run("nonexistent-command-xyz 2>&1 || true");
    check("Non-existent command handled", notFound.exitCode === 0);
    console.log();

    // ── Test 4: Large stdout ────────────────────────────────────────
    bold("━━━ Test 4: Large stdout output ━━━\n");

    // Generate ~100KB of output
    const largeOut = await sandbox.commands.run("seq 1 10000");
    const lineCount = largeOut.stdout.trim().split("\n").length;
    check("10000 lines of output captured", lineCount === 10000, `got ${lineCount} lines`);
    dim(`Output size: ${largeOut.stdout.length} chars`);

    // Verify first and last
    const largeLines = largeOut.stdout.trim().split("\n");
    check("First line is 1", largeLines[0] === "1");
    check("Last line is 10000", largeLines[lineCount - 1] === "10000");
    console.log();

    // ── Test 5: Environment variables ───────────────────────────────
    bold("━━━ Test 5: Environment variable passing ━━━\n");

    const envResult = await sandbox.commands.run("echo $MY_VAR", {
      env: { MY_VAR: "secret-value-123" },
    });
    check("Env var passed correctly", envResult.stdout.trim() === "secret-value-123");

    // Multiple env vars
    const multiEnv = await sandbox.commands.run('echo "$A:$B:$C"', {
      env: { A: "alpha", B: "beta", C: "gamma" },
    });
    check("Multiple env vars", multiEnv.stdout.trim() === "alpha:beta:gamma");

    // Env var with special characters
    const specialEnv = await sandbox.commands.run("echo $SPECIAL", {
      env: { SPECIAL: "hello world with spaces & stuff" },
    });
    check("Env var with special chars", specialEnv.stdout.trim() === "hello world with spaces & stuff");
    console.log();

    // ── Test 6: Working directory ───────────────────────────────────
    bold("━━━ Test 6: Working directory ━━━\n");

    await sandbox.commands.run("mkdir -p /tmp/workdir/sub");
    await sandbox.files.write("/tmp/workdir/sub/data.txt", "found-it");

    const cwdResult = await sandbox.commands.run("cat data.txt", {
      cwd: "/tmp/workdir/sub",
    });
    check("Working directory respected", cwdResult.stdout.trim() === "found-it");

    const pwdResult = await sandbox.commands.run("pwd", { cwd: "/tmp/workdir" });
    check("pwd reflects cwd", pwdResult.stdout.trim() === "/tmp/workdir");
    console.log();

    // ── Test 7: Shell features ──────────────────────────────────────
    bold("━━━ Test 7: Shell features (pipes, redirects, subshells) ━━━\n");

    // Pipes
    const pipeResult = await sandbox.commands.run("echo 'hello world' | tr ' ' '-'");
    check("Pipe works", pipeResult.stdout.trim() === "hello-world");

    // Subshell
    const subshell = await sandbox.commands.run("echo $(hostname)");
    check("Command substitution works", subshell.stdout.trim().length > 0, subshell.stdout.trim());

    // Redirect
    await sandbox.commands.run("echo redirect-test > /tmp/redirect.txt");
    const redirectContent = await sandbox.files.read("/tmp/redirect.txt");
    check("Redirect to file works", redirectContent.trim() === "redirect-test");

    // Wildcards
    await sandbox.commands.run("touch /tmp/wc-a.txt /tmp/wc-b.txt /tmp/wc-c.txt");
    const wcResult = await sandbox.commands.run("ls /tmp/wc-*.txt | wc -l");
    check("Wildcard expansion works", wcResult.stdout.trim() === "3");

    // Arithmetic
    const arith = await sandbox.commands.run("echo $((42 * 7))");
    check("Arithmetic expansion works", arith.stdout.trim() === "294");

    // Here string (bash-only feature, use bash explicitly)
    const hereStr = await sandbox.commands.run("bash -c \"cat <<< 'here-string-data'\"");
    check("Here string works", hereStr.stdout.trim() === "here-string-data");
    console.log();

    // ── Test 8: Concurrent commands on same sandbox ─────────────────
    bold("━━━ Test 8: Concurrent commands on same sandbox ━━━\n");

    const concurrentStart = Date.now();
    const concurrentPromises = Array.from({ length: 10 }, (_, i) =>
      sandbox!.commands.run(`echo concurrent-${i}`).then((r) => ({
        index: i,
        output: r.stdout.trim(),
        exitCode: r.exitCode,
      })),
    );

    const concurrentResults = await Promise.all(concurrentPromises);
    const concurrentMs = Date.now() - concurrentStart;

    let allCorrect = true;
    for (const r of concurrentResults) {
      if (r.output !== `concurrent-${r.index}` || r.exitCode !== 0) {
        allCorrect = false;
        dim(`Command ${r.index}: expected "concurrent-${r.index}", got "${r.output}" (exit ${r.exitCode})`);
      }
    }
    check("10 concurrent commands all returned correctly", allCorrect);
    dim(`Total concurrent time: ${concurrentMs}ms`);
    console.log();

    // ── Test 9: Command timeout ─────────────────────────────────────
    bold("━━━ Test 9: Command timeout ━━━\n");

    const timeoutStart = Date.now();
    try {
      await sandbox.commands.run("sleep 30", { timeout: 3 });
      // If it returns, check that it was killed (non-zero exit)
      const timeoutMs = Date.now() - timeoutStart;
      check("Command timed out within ~3s", timeoutMs < 10000, `took ${timeoutMs}ms`);
    } catch (err: any) {
      const timeoutMs = Date.now() - timeoutStart;
      check("Command timed out within ~3s", timeoutMs < 10000, `took ${timeoutMs}ms, error: ${err.message}`);
    }
    console.log();

  } catch (err: any) {
    red(`Fatal error: ${err.message}`);
    if (err.stack) dim(err.stack);
    failed++;
  } finally {
    if (sandbox) {
      await sandbox.kill();
      green("Sandbox killed");
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
