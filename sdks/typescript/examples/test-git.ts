/**
 * Git Operations Test
 *
 * Tests:
 *   1. Init repo (creates on server + sets up workspace)
 *   2. Push (stage, commit, push)
 *   3. Status / log / diff
 *   4. Clone into a second sandbox
 *   5. Branch and checkout
 *   6. Push from branch, pull from main
 *   7. Multiple commits (log history)
 *
 * Usage:
 *   npx tsx examples/test-git.ts
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

async function main() {
  bold("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  bold("\u2551       Git Operations Test                        \u2551");
  bold("\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n");

  // Use a unique repo name per run to avoid collisions
  const repoName = `test-git-${randomBytes(4).toString("hex")}`;

  let sandbox1: Sandbox | null = null;
  let sandbox2: Sandbox | null = null;

  try {
    sandbox1 = await Sandbox.create({ template: "base", timeout: 120 });
    green(`Created sandbox 1: ${sandbox1.sandboxId}`);
    console.log();

    // ── Test 1: Init repo ───────────────────────────────────────
    bold("━━━ Test 1: Init repo ━━━\n");

    const repo = await sandbox1.git.init({ name: repoName });
    check("Repo created with name", repo.name === repoName, `got ${repo.name}`);
    check("Repo has a slug", repo.slug.length > 0, `slug=${repo.slug}`);
    check("Repo has an id", repo.id.length > 0, `id=${repo.id}`);
    dim(`Repo: ${repo.slug} (id=${repo.id})`);

    const status = await sandbox1.git.status();
    check("Git status works after init", status.exitCode === 0, status.stderr);
    check("On main branch", status.stdout.includes("main"), status.stdout.slice(0, 80));
    console.log();

    // ── Test 2: Push ────────────────────────────────────────────
    bold("━━━ Test 2: Push ━━━\n");

    // Create a file and push
    await sandbox1.files.write("/workspace/hello.txt", "Hello from sandbox!");
    const pushResult = await sandbox1.git.push({ message: "initial commit" });
    check("Push exit code 0", pushResult.exitCode === 0, pushResult.stderr.slice(0, 200));
    check("Push mentions main branch", pushResult.stderr.includes("main"), pushResult.stderr.slice(0, 200));
    console.log();

    // ── Test 3: Status / log / diff ─────────────────────────────
    bold("━━━ Test 3: Status / log / diff ━━━\n");

    const status2 = await sandbox1.git.status();
    check("Clean status after push", status2.stdout.includes("nothing to commit"), status2.stdout.slice(0, 100));

    const log1 = await sandbox1.git.log();
    check("Log shows initial commit", log1.stdout.includes("initial commit"), log1.stdout.slice(0, 100));

    // Make a change and check diff
    await sandbox1.files.write("/workspace/hello.txt", "Hello updated!");
    const diff1 = await sandbox1.git.diff();
    check("Diff shows change", diff1.stdout.includes("Hello updated"), diff1.stdout.slice(0, 100));

    // Reset the change for clean state
    await sandbox1.commands.run("cd /workspace && git checkout -- hello.txt");
    console.log();

    // ── Test 4: Clone into second sandbox ───────────────────────
    bold("━━━ Test 4: Clone into second sandbox ━━━\n");

    sandbox2 = await Sandbox.create({ template: "base", timeout: 120 });
    green(`Created sandbox 2: ${sandbox2.sandboxId}`);

    const cloneResult = await sandbox2.git.clone(repo.slug, { path: "/tmp/cloned-repo" });
    check("Clone exit code 0", cloneResult.exitCode === 0, cloneResult.stderr.slice(0, 200));

    // Verify the file exists (use commands.run because /tmp is outside workspace volume)
    const catResult = await sandbox2.commands.run("cat /tmp/cloned-repo/hello.txt");
    check("Cloned file has correct content",
      catResult.stdout === "Hello from sandbox!",
      `got: ${catResult.stdout.slice(0, 50)}`);
    console.log();

    // ── Test 5: Branch and checkout ─────────────────────────────
    bold("━━━ Test 5: Branch and checkout ━━━\n");

    const branchResult = await sandbox1.git.branch("feature-1");
    check("Branch created", branchResult.exitCode === 0, branchResult.stderr);

    const status3 = await sandbox1.git.status();
    check("On feature-1 branch", status3.stdout.includes("feature-1"), status3.stdout.slice(0, 80));

    const checkoutResult = await sandbox1.git.checkout("main");
    check("Checkout main", checkoutResult.exitCode === 0, checkoutResult.stderr);

    const status4 = await sandbox1.git.status();
    check("Back on main", status4.stdout.includes("main"), status4.stdout.slice(0, 80));
    console.log();

    // ── Test 6: Push from branch, pull from second sandbox ──────
    bold("━━━ Test 6: Push and pull across sandboxes ━━━\n");

    // Switch to feature branch, add file, push
    await sandbox1.git.checkout("feature-1");
    await sandbox1.files.write("/workspace/feature.txt", "feature content");
    const push2 = await sandbox1.git.push({ message: "add feature file", branch: "feature-1" });
    check("Push feature branch", push2.exitCode === 0, push2.stderr.slice(0, 200));

    // Push a change on main too
    await sandbox1.git.checkout("main");
    await sandbox1.files.write("/workspace/main-update.txt", "main update");
    const push3 = await sandbox1.git.push({ message: "update main" });
    check("Push main update", push3.exitCode === 0, push3.stderr.slice(0, 200));

    // Pull from sandbox2 (cloned to /tmp/cloned-repo)
    const pullResult = await sandbox2.commands.run("cd /tmp/cloned-repo && git pull", { timeout: 60 });
    check("Pull succeeds", pullResult.exitCode === 0, pullResult.stderr.slice(0, 200));

    // Verify the pulled file (use commands.run because /tmp is outside workspace volume)
    const catMain = await sandbox2.commands.run("cat /tmp/cloned-repo/main-update.txt");
    check("Pulled file has correct content",
      catMain.stdout === "main update",
      `got: ${catMain.stdout.slice(0, 50)}`);
    console.log();

    // ── Test 7: Multiple commits and log history ────────────────
    bold("━━━ Test 7: Multiple commits and log ━━━\n");

    for (let i = 0; i < 3; i++) {
      await sandbox1.files.write(`/workspace/file-${i}.txt`, `content ${i}`);
      await sandbox1.git.push({ message: `commit ${i}` });
    }

    const log2 = await sandbox1.git.log(5);
    check("Log shows multiple commits", log2.exitCode === 0);

    const logLines = log2.stdout.trim().split("\n").filter((l: string) => l.trim());
    check("Log has at least 4 entries", logLines.length >= 4, `got ${logLines.length} lines`);
    dim(`Log output:\n    ${logLines.slice(0, 5).join("\n    ")}`);
    console.log();

  } catch (err: any) {
    red(`Fatal error: ${err.message || err}`);
    console.error(err);
    failed++;
  } finally {
    if (sandbox1) {
      await sandbox1.kill();
      green("Sandbox 1 killed");
    }
    if (sandbox2) {
      await sandbox2.kill();
      green("Sandbox 2 killed");
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
