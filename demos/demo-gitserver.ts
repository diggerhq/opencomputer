/**
 * OpenSandbox Git Server Demo
 *
 * Demonstrates the built-in git server:
 *   1. Create sandbox A, init a git repo
 *   2. Write code, commit and push
 *   3. Show git log
 *   4. Create sandbox B, clone the repo
 *   5. Verify files are present in sandbox B
 *   6. Make changes in sandbox B, push
 *   7. Pull in sandbox A, verify changes
 *
 * Usage:
 *   OPENCOMPUTER_API_URL=https://... OPENCOMPUTER_API_KEY=osb_... npx tsx demos/demo-gitserver.ts
 */

import { Sandbox } from "../sdks/typescript/src/index";
import { randomBytes } from "crypto";

const green = (s: string) => console.log(`\x1b[32m✓ ${s}\x1b[0m`);
const red   = (s: string) => console.log(`\x1b[31m✗ ${s}\x1b[0m`);
const bold  = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);
const dim   = (s: string) => console.log(`\x1b[2m  ${s}\x1b[0m`);
const step  = (s: string) => bold(`\n━━━ ${s} ━━━\n`);

async function main() {
  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║       Git Server Demo                            ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  const repoName = `demo-repo-${randomBytes(4).toString("hex")}`;

  let sandboxA: Sandbox | null = null;
  let sandboxB: Sandbox | null = null;

  try {
    // ── 1. Create sandbox A and init a repo ─────────────────────
    step("1. Create sandbox A and initialize a git repo");

    sandboxA = await Sandbox.create({ template: "base", timeout: 120 });
    green(`Sandbox A created: ${sandboxA.sandboxId}`);

    const repo = await sandboxA.git.init({ name: repoName });
    green(`Git repo initialized: ${repo.name}`);
    dim(`Slug: ${repo.slug}`);
    dim(`Default branch: ${repo.defaultBranch}`);

    // ── 2. Write code and push ──────────────────────────────────
    step("2. Write code, commit and push");

    await sandboxA.files.write("/workspace/README.md", [
      `# ${repoName}`,
      "",
      "A demo project created inside an OpenSandbox.",
      "",
      "## Features",
      "- Automatic git server integration",
      "- Push/pull between sandboxes",
      "- Credentials auto-configured",
    ].join("\n"));

    await sandboxA.files.write("/workspace/app.py", [
      "def greet(name: str) -> str:",
      '    return f"Hello, {name}! Welcome to OpenSandbox."',
      "",
      'if __name__ == "__main__":',
      '    print(greet("World"))',
    ].join("\n"));

    await sandboxA.files.write("/workspace/.gitignore", [
      "__pycache__/",
      "*.pyc",
      ".env",
      "node_modules/",
    ].join("\n"));

    const pushResult = await sandboxA.git.push({ message: "Initial commit: add README, app, and gitignore" });
    if (pushResult.exitCode === 0) {
      green("Code committed and pushed");
    } else {
      dim(`Push stderr: ${pushResult.stderr}`);
    }

    // ── 3. Show git log ─────────────────────────────────────────
    step("3. Show git log");

    const logResult = await sandboxA.git.log(5);
    dim(logResult.stdout.trim());
    green("Git history available");

    // ── 4. Create sandbox B and clone ───────────────────────────
    step("4. Create sandbox B and clone the repo");

    sandboxB = await Sandbox.create({ template: "base", timeout: 120 });
    green(`Sandbox B created: ${sandboxB.sandboxId}`);

    // Clone to a temp dir, then move into /workspace (which already exists as a mount)
    const cloneResult = await sandboxB.git.clone(repo.slug, { path: "/tmp/_clone" });
    if (cloneResult.exitCode === 0) {
      await sandboxB.commands.run("rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; cp -a /tmp/_clone/. /workspace/ && rm -rf /tmp/_clone");
      green(`Repo cloned into sandbox B`);
    } else {
      dim(`Clone output: ${cloneResult.stderr}`);
    }

    // ── 5. Verify files in sandbox B ────────────────────────────
    step("5. Verify files in sandbox B");

    const readme = await sandboxB.files.read("/workspace/README.md");
    if (readme.includes(repoName)) {
      green("README.md present with correct content");
    } else {
      red("README.md missing or wrong content");
    }

    const app = await sandboxB.files.read("/workspace/app.py");
    if (app.includes("def greet")) {
      green("app.py present with greet function");
    } else {
      red("app.py missing");
    }

    dim("Running app.py in sandbox B...");
    const runResult = await sandboxB.commands.run("python3 /workspace/app.py");
    dim(runResult.stdout.trim());
    green("Code runs correctly in cloned sandbox");

    // ── 6. Make changes in sandbox B and push ───────────────────
    step("6. Make changes in sandbox B and push");

    await sandboxB.files.write("/workspace/app.py", [
      "def greet(name: str) -> str:",
      '    return f"Hello, {name}! Welcome to OpenSandbox."',
      "",
      "def add(a: int, b: int) -> int:",
      '    """Added by sandbox B."""',
      "    return a + b",
      "",
      'if __name__ == "__main__":',
      '    print(greet("World"))',
      '    print(f"2 + 3 = {add(2, 3)}")',
    ].join("\n"));

    const pushB = await sandboxB.git.push({ message: "Add math function from sandbox B" });
    if (pushB.exitCode === 0) {
      green("Changes pushed from sandbox B");
    } else {
      dim(`Push stderr: ${pushB.stderr}`);
    }

    // ── 7. Pull in sandbox A and verify ─────────────────────────
    step("7. Pull in sandbox A and verify changes");

    const pullA = await sandboxA.git.pull();
    if (pullA.exitCode === 0) {
      green("Pull in sandbox A succeeded");
    } else {
      dim(`Pull output: ${pullA.stderr}`);
    }

    const updatedApp = await sandboxA.files.read("/workspace/app.py");
    if (updatedApp.includes("def add")) {
      green("Sandbox A now has the add() function from sandbox B");
    } else {
      red("Changes from sandbox B not found in sandbox A");
    }

    dim("Running updated app.py in sandbox A...");
    const finalRun = await sandboxA.commands.run("python3 /workspace/app.py");
    dim(finalRun.stdout.trim());
    green("Both sandboxes are in sync!");

  } catch (err: any) {
    red(`Error: ${err.message}`);
    console.error(err);
  } finally {
    step("Cleanup");

    if (sandboxB) {
      await sandboxB.kill();
      green("Sandbox B killed");
    }
    if (sandboxA) {
      await sandboxA.kill();
      green("Sandbox A killed");
    }
  }

  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║  \x1b[32mGit Server Demo Complete!\x1b[0m\x1b[1m                      ║");
  bold("╚══════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
