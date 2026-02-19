/**
 * File Operations Edge Cases Test
 *
 * Tests:
 *   1. Large file write/read (1MB)
 *   2. Binary-like content handling
 *   3. Deeply nested directories
 *   4. File deletion and overwrite
 *   5. List large directories
 *   6. Special characters in content
 *   7. Empty file handling
 *   8. File exists / not exists
 *
 * Usage:
 *   npx tsx examples/test-file-ops.ts
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
  bold("║       File Operations Edge Cases Test            ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  let sandbox: Sandbox | null = null;

  try {
    sandbox = await Sandbox.create({ template: "base", timeout: 120 });
    green(`Created sandbox: ${sandbox.sandboxId}`);
    console.log();

    // ── Test 1: Large file ──────────────────────────────────────────
    bold("━━━ Test 1: Large file (1MB) ━━━\n");

    const oneMB = "X".repeat(1024 * 1024);
    const writeStart = Date.now();
    await sandbox.files.write("/tmp/large.txt", oneMB);
    const writeMs = Date.now() - writeStart;
    dim(`Write: ${writeMs}ms`);

    const readStart = Date.now();
    const largeContent = await sandbox.files.read("/tmp/large.txt");
    const readMs = Date.now() - readStart;
    dim(`Read: ${readMs}ms`);

    check("1MB file size preserved", largeContent.length === oneMB.length, `${largeContent.length} bytes`);
    check("1MB file content intact", largeContent === oneMB);
    console.log();

    // ── Test 2: Special characters in content ───────────────────────
    bold("━━━ Test 2: Special characters ━━━\n");

    const specialContent = 'Hello "world" & <tag> \'quotes\' \\ newline\nTab\there 日本語 emoji🎉 nullish ?? chain?.';
    await sandbox.files.write("/tmp/special.txt", specialContent);
    const specialRead = await sandbox.files.read("/tmp/special.txt");
    check("Special characters preserved", specialRead === specialContent, `got: ${specialRead.substring(0, 50)}...`);

    // JSON content
    const jsonContent = JSON.stringify({ key: "value", nested: { arr: [1, 2, 3] }, unicode: "日本語" }, null, 2);
    await sandbox.files.write("/tmp/data.json", jsonContent);
    const jsonRead = await sandbox.files.read("/tmp/data.json");
    check("JSON content preserved", jsonRead === jsonContent);

    // Multi-line content
    const multiline = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: Some content here`).join("\n");
    await sandbox.files.write("/tmp/multiline.txt", multiline);
    const multiRead = await sandbox.files.read("/tmp/multiline.txt");
    check("100-line file preserved", multiRead === multiline, `lines: ${multiRead.split("\n").length}`);
    console.log();

    // ── Test 3: Deeply nested directories ───────────────────────────
    bold("━━━ Test 3: Deeply nested directories ━━━\n");

    const deepPath = "/tmp/a/b/c/d/e/f/g/h";
    // Create nested dirs step by step using commands (SDK mkdir doesn't do recursive)
    await sandbox.commands.run(`mkdir -p ${deepPath}`);
    await sandbox.files.write(`${deepPath}/deep.txt`, "bottom-of-tree");
    const deepContent = await sandbox.files.read(`${deepPath}/deep.txt`);
    check("8-level nested file created and read", deepContent === "bottom-of-tree");

    // List intermediate directory
    const midEntries = await sandbox.files.list("/tmp/a/b/c/d");
    check("Intermediate dir lists correctly", midEntries.some(e => e.name === "e" && e.isDir));
    console.log();

    // ── Test 4: File deletion and overwrite ──────────────────────────
    bold("━━━ Test 4: File deletion and overwrite ━━━\n");

    // Write → overwrite → verify new content
    await sandbox.files.write("/tmp/overwrite.txt", "original");
    let content = await sandbox.files.read("/tmp/overwrite.txt");
    check("Original content written", content === "original");

    await sandbox.files.write("/tmp/overwrite.txt", "overwritten");
    content = await sandbox.files.read("/tmp/overwrite.txt");
    check("Overwritten content correct", content === "overwritten");

    // Overwrite with shorter content
    await sandbox.files.write("/tmp/overwrite.txt", "short");
    content = await sandbox.files.read("/tmp/overwrite.txt");
    check("Shorter overwrite correct (no trailing data)", content === "short");

    // Delete
    const existsBefore = await sandbox.files.exists("/tmp/overwrite.txt");
    check("File exists before delete", existsBefore);

    await sandbox.files.remove("/tmp/overwrite.txt");
    const existsAfter = await sandbox.files.exists("/tmp/overwrite.txt");
    check("File gone after delete", !existsAfter);

    // Delete directory
    await sandbox.files.remove("/tmp/a");
    const dirGone = await sandbox.files.exists(`${deepPath}/deep.txt`);
    check("Recursive directory deletion", !dirGone);
    console.log();

    // ── Test 5: Large directory listing ─────────────────────────────
    bold("━━━ Test 5: Large directory listing ━━━\n");

    // Create 50 files
    await sandbox.commands.run(
      "for i in $(seq 1 50); do echo content-$i > /tmp/listtest-$i.txt; done",
    );
    const entries = await sandbox.files.list("/tmp");
    const listTestFiles = entries.filter(e => e.name.startsWith("listtest-"));
    check("50 files visible in listing", listTestFiles.length === 50, `found ${listTestFiles.length}`);

    // Verify entries have correct metadata
    const entry = listTestFiles[0];
    check("Entry has name", !!entry.name);
    check("Entry has isDir=false", entry.isDir === false);
    check("Entry has size > 0", entry.size > 0, `size=${entry.size}`);
    console.log();

    // ── Test 6: Empty file ──────────────────────────────────────────
    bold("━━━ Test 6: Empty file handling ━━━\n");

    await sandbox.files.write("/tmp/empty.txt", "");
    const emptyContent = await sandbox.files.read("/tmp/empty.txt");
    check("Empty file returns empty string", emptyContent === "", `got: "${emptyContent}"`);
    check("Empty file exists", await sandbox.files.exists("/tmp/empty.txt"));
    console.log();

    // ── Test 7: File exists / not exists ────────────────────────────
    bold("━━━ Test 7: File exists checks ━━━\n");

    check("Existing file → true", await sandbox.files.exists("/tmp/special.txt"));
    check("Non-existent file → false", !(await sandbox.files.exists("/tmp/nope-no-way.txt")));
    check("Non-existent deep path → false", !(await sandbox.files.exists("/tmp/no/such/path/file.txt")));
    console.log();

    // ── Test 8: Binary-like content ─────────────────────────────────
    bold("━━━ Test 8: Write via commands + read via SDK ━━━\n");

    // Write a script, execute it, read output via SDK
    await sandbox.commands.run('dd if=/dev/urandom bs=256 count=1 2>/dev/null | base64 > /tmp/random.b64');
    const b64Content = await sandbox.files.read("/tmp/random.b64");
    check("Base64 random data readable", b64Content.length > 100, `${b64Content.length} chars`);

    // Write via command, read via SDK
    await sandbox.commands.run('echo -n "command-written" > /tmp/cmd-file.txt');
    const cmdFileContent = await sandbox.files.read("/tmp/cmd-file.txt");
    check("Command-written file readable via SDK", cmdFileContent === "command-written");
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
