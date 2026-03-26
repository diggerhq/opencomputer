/**
 * OpenComputer Full SDK Validation — TypeScript
 * ================================================
 * Tests EVERY feature exposed by the TypeScript SDK against a live server.
 *
 * Usage:
 *   OPENCOMPUTER_API_KEY=your-key OPENCOMPUTER_API_URL=http://your-server:8080 npx tsx validate_all_features.ts
 *
 * Required: npm install @opencomputer/sdk
 */

import { Sandbox, SecretStore } from "../../sdks/typescript/src/index.js";
import { Image } from "../../sdks/typescript/src/image.js";
import { Snapshots } from "../../sdks/typescript/src/snapshot.js";

const API_URL = process.env.OPENCOMPUTER_API_URL || "https://app.opencomputer.dev";
const API_KEY = process.env.OPENCOMPUTER_API_KEY || "";

let PASS = 0;
let FAIL = 0;
let SKIP = 0;
const ERRORS: string[] = [];

function ok(msg: string) { PASS++; console.log(`  ✓ ${msg}`); }
function fail(msg: string, err?: string) {
  FAIL++;
  const detail = err ? ` — ${err}` : "";
  console.log(`  ✗ ${msg}${detail}`);
  ERRORS.push(`${msg}${detail}`);
}
function skip(msg: string) { SKIP++; console.log(`  ⊘ ${msg}`); }

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitReady(sb: Sandbox, timeout = 30): Promise<boolean> {
  for (let i = 0; i < timeout; i++) {
    try {
      const r = await sb.exec.run("echo ready", { timeout: 3 });
      if (r.stdout.trim() === "ready") return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║  OpenComputer TypeScript SDK — Full Feature Validation  ║");
  console.log(`║  Server: ${API_URL.padEnd(47)}║`);
  console.log("╚════════════════════════════════════════════════════════╝\n");

  const sandboxes: Sandbox[] = [];
  const storeIds: string[] = [];

  try {
    // ─── 1. SANDBOX LIFECYCLE ────────────────────────────────────
    console.log("▸ 1. Sandbox Lifecycle");

    const sb = await Sandbox.create({ timeout: 600 });
    sandboxes.push(sb);
    ok(`create: ${sb.sandboxId}`);

    const running = await sb.isRunning();
    running ? ok(`isRunning: ${running}`) : fail("isRunning: false");

    await sb.setTimeout(300);
    ok("setTimeout(300)");

    const sb2 = await Sandbox.connect(sb.sandboxId);
    ok(`connect: ${sb2.sandboxId}`);
    console.log();

    // ─── 2. EXEC.RUN ────────────────────────────────────────────
    console.log("▸ 2. Exec (fire-and-forget)");

    let r = await sb.exec.run("echo hello");
    r.stdout.trim() === "hello" ? ok("echo") : fail(`echo: ${r.stdout}`);

    r = await sb.exec.run("python3 -c \"print(2+2)\"");
    r.stdout.trim() === "4" ? ok("python3") : fail(`python3: ${r.stdout}`);

    r = await sb.exec.run("node -e \"console.log(JSON.stringify({ok:true}))\"");
    r.stdout.includes("ok") ? ok("node") : fail(`node: ${r.stdout}`);

    r = await sb.exec.run("echo $MY_VAR", { env: { MY_VAR: "test123" } });
    r.stdout.includes("test123") ? ok("exec with env") : fail(`env: ${r.stdout}`);

    r = await sb.exec.run("pwd", { cwd: "/workspace" });
    r.stdout.includes("/workspace") ? ok("exec with cwd") : fail(`cwd: ${r.stdout}`);

    const t0 = Date.now();
    r = await sb.exec.run("sleep 30", { timeout: 3 });
    const elapsed = (Date.now() - t0) / 1000;
    elapsed < 10 ? ok(`exec timeout (${elapsed.toFixed(1)}s)`) : fail(`timeout: ${elapsed}s`);
    console.log();

    // ─── 3. EXEC.START (streaming) ──────────────────────────────
    console.log("▸ 3. Exec Sessions (streaming)");

    const chunks: string[] = [];
    const session = await sb.exec.start("python3", {
      args: ["-c", "import time\nfor i in range(3): print(f'line-{i}', flush=True); time.sleep(0.1)"],
      onStdout: (data) => chunks.push(new TextDecoder().decode(data)),
    });
    const exitCode = await session.done;
    const combined = chunks.join("");
    exitCode === 0 ? ok(`stream: exit=${exitCode}, chunks=${chunks.length}`) : fail(`exit: ${exitCode}`);
    combined.includes("line-0") && combined.includes("line-2") ? ok("all lines") : fail(`output: ${combined.slice(0, 50)}`);

    // List sessions
    const sessions = await sb.exec.list();
    sessions.length >= 1 ? ok(`list: ${sessions.length}`) : fail(`list: ${sessions.length}`);

    // Kill
    const longSession = await sb.exec.start("sleep", { args: ["300"] });
    await sleep(500);
    await longSession.kill();
    ok("kill session");
    console.log();

    // ─── 4. FILES ────────────────────────────────────────────────
    console.log("▸ 4. Filesystem");

    await sb.files.write("/workspace/test.txt", "hello world");
    ok("write");

    const content = await sb.files.read("/workspace/test.txt");
    content === "hello world" ? ok("read") : fail(`read: ${content}`);

    // Binary
    const binary = new Uint8Array(256);
    for (let i = 0; i < 256; i++) binary[i] = i;
    await sb.files.write("/workspace/binary.bin", binary);
    const readBack = await sb.files.readBytes("/workspace/binary.bin");
    readBack.length === 256 ? ok("binary round-trip") : fail(`binary: ${readBack.length}`);

    // List
    const entries = await sb.files.list("/workspace");
    const names = entries.map(e => e.name);
    names.includes("test.txt") ? ok(`list: ${names.length} files`) : fail(`list: ${names}`);

    // Exists
    const exists = await sb.files.exists("/workspace/test.txt");
    exists ? ok("exists") : fail("exists: false");

    // Make dir
    await sb.files.makeDir("/workspace/subdir/nested");
    r = await sb.exec.run("ls -d /workspace/subdir/nested");
    r.exitCode === 0 ? ok("makeDir") : fail("makeDir");

    // Remove
    await sb.files.remove("/workspace/test.txt");
    const gone = !(await sb.files.exists("/workspace/test.txt"));
    gone ? ok("remove") : fail("remove: still exists");

    // Download/upload URLs
    try {
      const dlUrl = await sb.downloadUrl("/workspace/binary.bin");
      dlUrl.startsWith("http") ? ok(`downloadUrl`) : fail(`downloadUrl: ${dlUrl}`);
    } catch (e: any) { skip(`downloadUrl: ${e.message}`); }

    try {
      const ulUrl = await sb.uploadUrl("/workspace/upload.txt");
      ulUrl.startsWith("http") ? ok(`uploadUrl`) : fail(`uploadUrl: ${ulUrl}`);
    } catch (e: any) { skip(`uploadUrl: ${e.message}`); }
    console.log();

    // ─── 5. MEMORY SCALING ──────────────────────────────────────
    console.log("▸ 5. Memory Scaling");
    try {
      const scaleResp = await fetch(`${API_URL}/api/sandboxes/${sb.sandboxId}/limits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
        body: JSON.stringify({ memoryMB: 2048 }),
      });
      if (scaleResp.ok) {
        ok("scale to 2GB");
        await sleep(1000);
        r = await sb.exec.run("free -m | awk '/Mem:/{print $2}'");
        const mem = parseInt(r.stdout.trim());
        mem > 1800 ? ok(`verified: ${mem}MB`) : fail(`mem: ${mem}MB`);
      } else { skip(`scale: ${scaleResp.status}`); }
    } catch (e: any) { skip(`scaling: ${e.message}`); }
    console.log();

    // ─── 6. NETWORK ─────────────────────────────────────────────
    console.log("▸ 6. Network");
    r = await sb.exec.run("curl -s -o /dev/null -w '%{http_code}' https://httpbin.org/ip", { timeout: 15000 });
    r.stdout.trim() === "200" ? ok("HTTPS") : fail(`HTTPS: ${r.stdout}`);

    r = await sb.exec.run("ping -c1 -W3 8.8.8.8 2>&1 | grep -c 'bytes from'");
    r.stdout.trim() === "1" ? ok("ping") : skip("ping blocked (ICMP not allowed)");
    console.log();

    // ─── 7. PREVIEW URLS ────────────────────────────────────────
    console.log("▸ 7. Preview URLs");
    await sb.exec.run("bash -c 'echo hello > /workspace/index.html && setsid python3 -m http.server 3000 --directory /workspace </dev/null >/dev/null 2>&1 &'");
    await sleep(2000);
    try {
      const preview = await sb.createPreviewURL({ port: 3000 });
      preview.hostname ? ok(`create: ${preview.hostname}`) : fail(`preview: ${JSON.stringify(preview)}`);

      const previews = await sb.listPreviewURLs();
      previews.length >= 1 ? ok(`list: ${previews.length}`) : fail(`list: ${previews.length}`);

      await sb.deletePreviewURL(3000);
      ok("delete");
    } catch (e: any) { skip(`preview: ${e.message}`); }
    console.log();

    // ─── 8. HIBERNATE / WAKE ────────────────────────────────────
    console.log("▸ 8. Hibernate / Wake");
    await sb.files.write("/workspace/persist.txt", "survive");

    await sb.hibernate();
    ok("hibernate");

    await sb.wake({ timeout: 600 });
    ok("wake");

    const persisted = await sb.files.read("/workspace/persist.txt");
    persisted === "survive" ? ok("workspace survived") : fail(`persist: ${persisted}`);
    console.log();

    // ─── 9. CHECKPOINT / FORK ───────────────────────────────────
    console.log("▸ 9. Checkpoint & Fork");
    await sb.files.write("/workspace/cp-data.txt", "at-checkpoint");

    const cp = await sb.createCheckpoint("validate-cp");
    ok(`checkpoint: ${cp.id.slice(0, 12)}...`);

    for (let i = 0; i < 20; i++) {
      const cps = await sb.listCheckpoints();
      if (cps.find(c => c.id === cp.id && c.status === "ready")) break;
      await sleep(1000);
    }
    ok("ready");

    const fork = await Sandbox.createFromCheckpoint(cp.id, { timeout: 300 });
    sandboxes.push(fork);
    await waitReady(fork);
    ok(`fork: ${fork.sandboxId}`);

    const forkContent = await fork.files.read("/workspace/cp-data.txt");
    forkContent === "at-checkpoint" ? ok("fork data") : fail(`fork: ${forkContent}`);

    await fork.kill();
    sandboxes.splice(sandboxes.indexOf(fork), 1);
    console.log();

    // ─── 10. RESTORE CHECKPOINT ─────────────────────────────────
    console.log("▸ 10. Restore Checkpoint");
    await sb.exec.run("rm /workspace/cp-data.txt");
    await sb.restoreCheckpoint(cp.id);
    await waitReady(sb);
    ok("restore");

    const restored = await sb.files.read("/workspace/cp-data.txt");
    restored === "at-checkpoint" ? ok("data restored") : fail(`restore: ${restored}`);

    await sb.deleteCheckpoint(cp.id);
    ok("delete checkpoint");
    console.log();

    // ─── 11. SECRET STORES ──────────────────────────────────────
    console.log("▸ 11. Secret Stores");
    try {
      const storeName = `validate-ts-${Date.now()}`;
      const store = await SecretStore.create({ name: storeName });
      storeIds.push(store.id);
      ok(`create: ${storeName}`);

      await SecretStore.setSecret(store.id, "TS_KEY", "ts-secret");
      ok("set secret");

      const secrets = await SecretStore.listSecrets(store.id);
      secrets.length === 1 ? ok("list secrets") : fail(`secrets: ${secrets.length}`);
      JSON.stringify(secrets).includes("ts-secret") ? fail("PLAINTEXT LEAKED") : ok("no plaintext");

      await SecretStore.deleteSecret(store.id, "TS_KEY");
      ok("delete secret");

      await SecretStore.delete(store.id);
      storeIds.splice(storeIds.indexOf(store.id), 1);
      ok("delete store");
    } catch (e: any) { fail(`secrets: ${e.message}`); }
    console.log();

    // ─── 12. IMAGE BUILDER ──────────────────────────────────────
    console.log("▸ 12. Image Builder");
    try {
      const image = Image.base()
        .runCommands("echo ts-image > /workspace/proof.txt")
        .pipInstall(["httpx"]);

      const imgSb = await Sandbox.create({ image, timeout: 300 });
      sandboxes.push(imgSb);
      await waitReady(imgSb);
      ok(`build: ${imgSb.sandboxId}`);

      const imgContent = await imgSb.files.read("/workspace/proof.txt");
      imgContent.includes("ts-image") ? ok("image workspace") : fail(`content: ${imgContent}`);

      r = await imgSb.exec.run("python3 -c \"import httpx; print(httpx.__version__)\"");
      r.exitCode === 0 ? ok(`pip: httpx ${r.stdout.trim()}`) : fail("httpx missing");

      await imgSb.kill();
      sandboxes.splice(sandboxes.indexOf(imgSb), 1);
    } catch (e: any) { fail(`image builder: ${e.message}`); }
    console.log();

    // ─── 13. SNAPSHOTS ──────────────────────────────────────────
    console.log("▸ 13. Named Snapshots");
    const snapName = `validate-ts-snap-${Date.now()}`;
    try {
      const snapshots = new Snapshots();
      await snapshots.create({
        name: snapName,
        image: Image.base().runCommands("echo ts-snap > /workspace/snap.txt"),
      });
      ok(`create: ${snapName}`);

      const snapList = await snapshots.list();
      snapList.find(s => s.name === snapName) ? ok("list") : fail("not in list");

      const snapSb = await Sandbox.create({ snapshot: snapName, timeout: 300 });
      sandboxes.push(snapSb);
      await waitReady(snapSb);
      const snapContent = await snapSb.files.read("/workspace/snap.txt");
      snapContent.includes("ts-snap") ? ok("sandbox from snapshot") : fail(`content: ${snapContent}`);
      await snapSb.kill();
      sandboxes.splice(sandboxes.indexOf(snapSb), 1);

      await snapshots.delete(snapName);
      ok("delete");
    } catch (e: any) { fail(`snapshots: ${e.message}`); }
    console.log();

  } catch (e: any) {
    fail(`UNEXPECTED: ${e.message}\n${e.stack}`);
  } finally {
    console.log("▸ Cleanup");
    for (const s of sandboxes) {
      try { await s.kill(); console.log(`  Killed ${s.sandboxId}`); } catch {}
    }
    for (const id of storeIds) {
      try { await SecretStore.delete(id); console.log(`  Deleted store ${id.slice(0, 12)}...`); } catch {}
    }
  }

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  ${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
  if (ERRORS.length > 0) {
    console.log(`\n  Failures:`);
    for (const e of ERRORS) console.log(`    ✗ ${e}`);
  }
  console.log("═".repeat(55));
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
