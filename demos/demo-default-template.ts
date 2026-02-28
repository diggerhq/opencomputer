/**
 * OpenSandbox Default Template Demo
 *
 * Shows what comes pre-installed in the default "base" template:
 *   1. Languages: Python 3, Node.js 20, npm
 *   2. Tools: git, curl, jq, sqlite3, htop, tree
 *   3. Build tools: gcc, make, cmake
 *   4. NVMe-backed workspace at /workspace
 *   5. Smoke tests: run Python and Node.js scripts
 *   6. HOME=/workspace — dotfiles and caches go to the fast drive
 *
 * Usage:
 *   OPENCOMPUTER_API_URL=https://... OPENCOMPUTER_API_KEY=osb_... npx tsx demos/demo-default-template.ts
 */

import { Sandbox } from "../sdks/typescript/src/index";

const green = (s: string) => console.log(`\x1b[32m✓ ${s}\x1b[0m`);
const red   = (s: string) => console.log(`\x1b[31m✗ ${s}\x1b[0m`);
const bold  = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);
const dim   = (s: string) => console.log(`\x1b[2m  ${s}\x1b[0m`);
const step  = (s: string) => bold(`\n━━━ ${s} ━━━\n`);

async function check(sandbox: Sandbox, desc: string, cmd: string): Promise<boolean> {
  const result = await sandbox.commands.run(cmd);
  const output = result.stdout.trim();
  if (result.exitCode === 0 && output) {
    green(`${desc}: ${output}`);
    return true;
  } else {
    red(`${desc}: not found`);
    return false;
  }
}

async function main() {
  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║       Default Template — What's in the Box       ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  let sandbox: Sandbox | null = null;

  try {
    // ── 1. Create a sandbox ─────────────────────────────────────
    step("1. Create a sandbox (base template)");

    const start = Date.now();
    sandbox = await Sandbox.create({ template: "base", timeout: 120 });
    const elapsed = Date.now() - start;
    green(`Sandbox created: ${sandbox.sandboxId} (${elapsed}ms)`);

    // ── 2. Languages ────────────────────────────────────────────
    step("2. Pre-installed languages");

    await check(sandbox, "Python", "python3 --version");
    await check(sandbox, "pip", "pip3 --version 2>&1 | head -1");
    await check(sandbox, "Node.js", "node --version");
    await check(sandbox, "npm", "npm --version");

    // ── 3. Developer tools ──────────────────────────────────────
    step("3. Developer tools");

    await check(sandbox, "git", "git --version");
    await check(sandbox, "curl", "curl --version | head -1");
    await check(sandbox, "jq", "jq --version");
    await check(sandbox, "sqlite3", "sqlite3 --version");
    await check(sandbox, "htop", "htop --version | head -1");
    await check(sandbox, "tree", "tree --version");

    // ── 4. Build tools ──────────────────────────────────────────
    step("4. Build tools");

    await check(sandbox, "gcc", "gcc --version | head -1");
    await check(sandbox, "make", "make --version | head -1");
    await check(sandbox, "cmake", "cmake --version | head -1");

    // ── 5. Workspace & storage ──────────────────────────────────
    step("5. Workspace & storage");

    const dfResult = await sandbox.commands.run("df -h /workspace | tail -1");
    dim(`Filesystem: ${dfResult.stdout.trim()}`);

    const devLine = dfResult.stdout.trim();
    if (!devLine.startsWith("/dev/root")) {
      green("/workspace is on a dedicated drive (NVMe-backed)");
    } else {
      red("/workspace is on the rootfs");
    }

    const homeResult = await sandbox.commands.run("echo $HOME");
    if (homeResult.stdout.trim() === "/workspace") {
      green("HOME=/workspace — caches and dotfiles use the fast drive");
    } else {
      red(`HOME=${homeResult.stdout.trim()} (expected /workspace)`);
    }

    // ── 6. Python smoke test ────────────────────────────────────
    step("6. Python smoke test");

    await sandbox.files.write("/workspace/test.py", [
      "import json, sqlite3, os, sys",
      "",
      "# Create an in-memory SQLite database",
      "conn = sqlite3.connect(':memory:')",
      "conn.execute('CREATE TABLE demo (id INTEGER PRIMARY KEY, msg TEXT)')",
      "conn.execute(\"INSERT INTO demo VALUES (1, 'Hello from Python!')\")",
      "row = conn.execute('SELECT msg FROM demo WHERE id=1').fetchone()",
      "conn.close()",
      "",
      "print(f'Python {sys.version.split()[0]} on {os.uname().machine}')",
      "print(f'SQLite says: {row[0]}')",
      "print(f'JSON works: {json.dumps({\"status\": \"ok\"})}')",
    ].join("\n"));

    const pyResult = await sandbox.commands.run("python3 /workspace/test.py");
    if (pyResult.exitCode === 0) {
      for (const line of pyResult.stdout.trim().split("\n")) {
        dim(line);
      }
      green("Python smoke test passed");
    } else {
      red(`Python failed: ${pyResult.stderr}`);
    }

    // ── 7. Node.js smoke test ───────────────────────────────────
    step("7. Node.js smoke test");

    await sandbox.files.write("/workspace/test.js", [
      "const os = require('os');",
      "const crypto = require('crypto');",
      "const http = require('http');",
      "",
      "const hash = crypto.createHash('sha256').update('OpenSandbox').digest('hex').slice(0, 16);",
      "console.log(`Node.js ${process.version} on ${os.arch()}`);",
      "console.log(`SHA-256('OpenSandbox') = ${hash}...`);",
      "console.log(`Memory: ${Math.round(os.totalmem() / 1024 / 1024)}MB total`);",
    ].join("\n"));

    const nodeResult = await sandbox.commands.run("node /workspace/test.js");
    if (nodeResult.exitCode === 0) {
      for (const line of nodeResult.stdout.trim().split("\n")) {
        dim(line);
      }
      green("Node.js smoke test passed");
    } else {
      red(`Node.js failed: ${nodeResult.stderr}`);
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
  }

  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║  \x1b[32mDefault Template Demo Complete!\x1b[0m\x1b[1m                ║");
  bold("╚══════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
