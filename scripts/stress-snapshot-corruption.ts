/**
 * Snapshot Corruption Stress Test (v2)
 *
 * Two-phase test designed to expose snapshot corruption in OpenComputer.
 *
 * Phase 1 — Fork Blast (Vector 4, deterministic):
 *   Create sandbox → write marker → checkpoint → launch N forks simultaneously
 *   → delete checkpoint while forks are booting → verify each fork's data.
 *   Repeated M rounds.
 *
 * Phase 2 — Hibernate/Wake Soak (Vector 1, statistical):
 *   Create N sandboxes → write marker → loop K hibernate/wake cycles with
 *   SHA256 verification after each wake. Cross-worker wakes (which download
 *   from S3) happen naturally at scale, exposing archive corruption.
 *
 * Usage:
 *   npx tsx scripts/stress-snapshot-corruption.ts -n 5 -c 2
 *   npx tsx scripts/stress-snapshot-corruption.ts -n 20 -c 5 --cycles 5 --fork-rounds 5
 *   npx tsx scripts/stress-snapshot-corruption.ts -n 20 -c 5 -o report.json
 */

import { Sandbox } from "../sdks/typescript/src/index";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

// ── CLI args ────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    count: { type: "string", short: "n", default: "20" },
    concurrency: { type: "string", short: "c", default: "5" },
    cycles: { type: "string", default: "5" },
    "marker-size": { type: "string", default: "5" },
    "fork-rounds": { type: "string", default: "5" },
    "forks-per-round": { type: "string", default: "5" },
    "api-key": { type: "string", default: process.env.OPENCOMPUTER_API_KEY ?? "" },
    "api-url": { type: "string", default: process.env.OPENCOMPUTER_API_URL ?? "" },
    output: { type: "string", short: "o", default: "" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
Snapshot Corruption Stress Test (v2)

Phase 1: Fork blast — deterministic test for checkpoint cache corruption (Vector 4)
Phase 2: Hibernate/wake soak — statistical test for archive corruption (Vector 1)

Options:
  -n, --count <num>           Sandboxes for hibernate/wake soak (default: 20)
  -c, --concurrency <num>    Max simultaneous sandboxes (default: 5)
  --cycles <num>              Hibernate/wake cycles per sandbox (default: 5)
  --marker-size <mb>          Marker file size in MB (default: 5)
  --fork-rounds <num>         Fork blast rounds, 0 to skip (default: 5)
  --forks-per-round <num>     Concurrent forks per round (default: 5)
  --api-key <key>             API key (default: $OPENCOMPUTER_API_KEY)
  --api-url <url>             API URL (default: $OPENCOMPUTER_API_URL)
  -o, --output <file>         Write JSON report to file
  -h, --help                  Show this help
`);
  process.exit(0);
}

const COUNT = parseInt(args.count!, 10);
const CONCURRENCY = parseInt(args.concurrency!, 10);
const CYCLES = parseInt(args.cycles!, 10);
const MARKER_SIZE_MB = parseInt(args["marker-size"]!, 10);
const FORK_ROUNDS = parseInt(args["fork-rounds"]!, 10);
const FORKS_PER_ROUND = parseInt(args["forks-per-round"]!, 10);
const API_KEY = args["api-key"]!;
const API_URL = args["api-url"]! || undefined;
const OUTPUT = args.output || undefined;

if (!API_KEY) {
  console.error("Error: --api-key or $OPENCOMPUTER_API_KEY required");
  process.exit(1);
}

// ── Types ───────────────────────────────────────────────────────────────

interface ForkResult {
  sandboxId: string;
  markerVerified: boolean;
  actualSha256?: string;
  error?: string;
}

interface ForkBlastRound {
  round: number;
  sourceSandboxId: string;
  checkpointId: string;
  markerSha256: string;
  forks: ForkResult[];
  checkpointDeletedDuringForks: boolean;
  corrupted: number;
  error?: string;
}

interface CycleResult {
  cycle: number;
  hibernateMs: number;
  wakeMs: number;
  verified: boolean;
  actualSha256?: string;
}

interface HibernateWakeResult {
  index: number;
  sandboxId: string;
  markerPath: string;
  markerSha256: string;
  cycles: CycleResult[];
  corrupted: boolean;
  corruptedAtCycle?: number;
  error?: string;
  failedAt?: string;
}

interface TestReport {
  startedAt: string;
  completedAt: string;
  config: {
    count: number;
    concurrency: number;
    cycles: number;
    forkRounds: number;
    forksPerRound: number;
    markerSizeMB: number;
  };
  phase1_forkBlast: {
    rounds: ForkBlastRound[];
    totalForks: number;
    totalCorrupted: number;
  };
  phase2_hibernateWake: {
    results: HibernateWakeResult[];
    totalCycles: number;
    totalCorrupted: number;
    totalErrored: number;
  };
  summary: {
    totalDurationMs: number;
    corruption: boolean;
  };
}

// ── Formatting helpers ──────────────────────────────────────────────────

function green(msg: string) { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }
function red(msg: string) { console.log(`\x1b[31m✗ ${msg}\x1b[0m`); }
function bold(msg: string) { console.log(`\x1b[1m${msg}\x1b[0m`); }
function dim(msg: string) { console.log(`\x1b[2m  ${msg}\x1b[0m`); }
function yellow(msg: string) { console.log(`\x1b[33m⚠ ${msg}\x1b[0m`); }

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function sleep(ms: number) {
  return new Promise((r) => globalThis.setTimeout(r, ms));
}

function sha256(data: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Concurrency pool ────────────────────────────────────────────────────

function createPool(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    active++;
  }

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) next();
  }

  return { acquire, release };
}

// ── Core helpers ────────────────────────────────────────────────────────

const sdkOpts = {
  ...(API_KEY ? { apiKey: API_KEY } : {}),
  ...(API_URL ? { apiUrl: API_URL } : {}),
};

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

async function writeMarker(
  sb: Sandbox,
  name: string,
): Promise<{ path: string; sha256: string }> {
  const data = randomBytes(MARKER_SIZE_MB * 1024 * 1024).toString("base64");
  const hash = sha256(data);
  const path = `/home/user/${name}`;
  await sb.files.write(path, data);
  const readBack = await sb.files.read(path);
  if (sha256(readBack) !== hash) {
    throw new Error(`Write verification failed for ${name}`);
  }
  return { path, sha256: hash };
}

async function verifyMarker(
  sb: Sandbox,
  path: string,
  expectedSha256: string,
): Promise<{ verified: boolean; actualSha256: string }> {
  const content = await sb.files.read(path);
  const actual = sha256(content);
  return { verified: actual === expectedSha256, actualSha256: actual };
}

async function waitForCheckpointReady(
  sb: Sandbox,
  checkpointId: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await sb.listCheckpoints();
    const cp = list.find((c) => c.id === checkpointId);
    if (cp && cp.status === "ready") return true;
    if (cp && cp.status !== "processing") return false;
    await sleep(2000);
  }
  return false;
}

// ── Phase 1: Fork Blast ─────────────────────────────────────────────────

async function runForkBlastRound(round: number): Promise<ForkBlastRound> {
  const result: ForkBlastRound = {
    round,
    sourceSandboxId: "",
    checkpointId: "",
    markerSha256: "",
    forks: [],
    checkpointDeletedDuringForks: false,
    corrupted: 0,
  };

  let sb: Sandbox | undefined;
  const forkSandboxes: Sandbox[] = [];

  try {
    // Setup: create sandbox, write marker, checkpoint
    sb = await Sandbox.create({ timeout: 300, ...sdkOpts });
    result.sourceSandboxId = sb.sandboxId;
    dim(`  [round ${round}] source sandbox: ${sb.sandboxId}`);

    const marker = await writeMarker(sb, `fork-marker-${round}.bin`);
    result.markerSha256 = marker.sha256;
    dim(`  [round ${round}] marker written`);

    const cp = await sb.createCheckpoint(`fork-blast-${round}-${Date.now()}`);
    result.checkpointId = cp.id;
    const ready = await waitForCheckpointReady(sb, cp.id);
    if (!ready) throw new Error(`Checkpoint ${cp.id} never became ready`);
    dim(`  [round ${round}] checkpoint ready: ${cp.id}`);

    // Launch forks simultaneously
    const forkPromises = Array.from({ length: FORKS_PER_ROUND }, async (_, i) => {
      let fork: Sandbox | undefined;
      try {
        fork = await Sandbox.createFromCheckpoint(cp.id, { timeout: 120, ...sdkOpts });
        forkSandboxes.push(fork);
        dim(`  [round ${round}] fork[${i}] created: ${fork.sandboxId}`);

        const v = await verifyMarker(fork, marker.path, marker.sha256);
        const entry: ForkResult = {
          sandboxId: fork.sandboxId,
          markerVerified: v.verified,
          actualSha256: v.actualSha256,
        };
        if (!v.verified) {
          entry.error = `expected ${marker.sha256}, got ${v.actualSha256}`;
          red(`  [round ${round}] fork[${i}] CORRUPTED`);
        } else {
          green(`  [round ${round}] fork[${i}] verified OK`);
        }
        return entry;
      } catch (err: any) {
        return {
          sandboxId: fork?.sandboxId ?? "unknown",
          markerVerified: false,
          error: err.message,
        } as ForkResult;
      }
    });

    // Delete checkpoint while forks are in progress (the race)
    // Small delay to let fork requests reach the server, then delete
    await sleep(500);
    try {
      await sb.deleteCheckpoint(cp.id);
      result.checkpointDeletedDuringForks = true;
      dim(`  [round ${round}] checkpoint deleted while forks in progress`);
    } catch (err: any) {
      dim(`  [round ${round}] checkpoint delete failed (expected if forks hold lock): ${err.message}`);
    }

    const forkResults = await Promise.allSettled(forkPromises);
    result.forks = forkResults.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { sandboxId: "unknown", markerVerified: false, error: r.reason?.message }
    );
    result.corrupted = result.forks.filter((f) => !f.markerVerified).length;

  } catch (err: any) {
    result.error = err.message;
    red(`  [round ${round}] FAILED: ${err.message}`);
  } finally {
    // Cleanup
    const toKill = [...forkSandboxes];
    if (sb) toKill.push(sb);
    await Promise.allSettled(toKill.map((s) => s.kill().catch(() => {})));
  }

  return result;
}

async function phase1_forkBlast(): Promise<TestReport["phase1_forkBlast"]> {
  bold("\n╔══════════════════════════════════════════════════════════╗");
  bold("║  Phase 1: Fork Blast (Vector 4 — checkpoint cache)      ║");
  bold("╚══════════════════════════════════════════════════════════╝");
  dim(`${FORK_ROUNDS} rounds × ${FORKS_PER_ROUND} forks each\n`);

  const rounds: ForkBlastRound[] = [];

  // Run rounds sequentially (each round creates its own sandbox)
  for (let i = 0; i < FORK_ROUNDS; i++) {
    const round = await runForkBlastRound(i);
    rounds.push(round);
  }

  const totalForks = rounds.reduce((sum, r) => sum + r.forks.length, 0);
  const totalCorrupted = rounds.reduce((sum, r) => sum + r.corrupted, 0);

  console.log();
  if (totalCorrupted > 0) {
    red(`Phase 1: ${totalForks} forks, ${totalCorrupted} CORRUPTED`);
  } else {
    green(`Phase 1: ${totalForks} forks, 0 corrupted`);
  }

  return { rounds, totalForks, totalCorrupted };
}

// ── Phase 2: Hibernate/Wake Soak ────────────────────────────────────────

async function runHibernateWakeSoak(index: number): Promise<HibernateWakeResult> {
  const result: HibernateWakeResult = {
    index,
    sandboxId: "",
    markerPath: "",
    markerSha256: "",
    cycles: [],
    corrupted: false,
  };

  let sb: Sandbox | undefined;

  try {
    // Create and write marker
    sb = await Sandbox.create({ timeout: 300, ...sdkOpts });
    result.sandboxId = sb.sandboxId;
    dim(`[${index}] created ${sb.sandboxId}`);

    const marker = await writeMarker(sb, `soak-marker-${index}.bin`);
    result.markerPath = marker.path;
    result.markerSha256 = marker.sha256;
    dim(`[${index}] marker written`);

    // Hibernate/wake cycles
    for (let c = 0; c < CYCLES; c++) {
      const cycleResult: CycleResult = { cycle: c, hibernateMs: 0, wakeMs: 0, verified: false };

      // Hibernate
      const { ms: hibMs } = await timed(() => sb!.hibernate());
      cycleResult.hibernateMs = hibMs;

      // Wake immediately — no delay
      const { ms: wakeMs } = await timed(() => sb!.wake({ timeout: 120 }));
      cycleResult.wakeMs = wakeMs;

      // Verify
      const v = await verifyMarker(sb, marker.path, marker.sha256);
      cycleResult.verified = v.verified;
      cycleResult.actualSha256 = v.actualSha256;

      result.cycles.push(cycleResult);

      if (!v.verified) {
        result.corrupted = true;
        result.corruptedAtCycle = c;
        red(`[${index}] CORRUPTED at cycle ${c} — expected ${marker.sha256}, got ${v.actualSha256}`);
        break; // stop cycling, corruption found
      }

      dim(`[${index}] cycle ${c}/${CYCLES - 1} OK (h=${formatMs(hibMs)} w=${formatMs(wakeMs)})`);
    }

    if (!result.corrupted) {
      green(`[${index}] ${CYCLES} cycles passed`);
    }

    // Destroy
    await sb.kill();
    sb = undefined;

  } catch (err: any) {
    result.error = err.message;
    result.failedAt = result.cycles.length > 0
      ? `cycle ${result.cycles.length - 1}`
      : "setup";
    red(`[${index}] FAILED at ${result.failedAt}: ${err.message}`);
  } finally {
    if (sb) {
      try { await sb.kill(); } catch {}
    }
  }

  return result;
}

async function phase2_hibernateWake(): Promise<TestReport["phase2_hibernateWake"]> {
  bold("\n╔══════════════════════════════════════════════════════════╗");
  bold("║  Phase 2: Hibernate/Wake Soak (Vector 1 — S3 archive)   ║");
  bold("╚══════════════════════════════════════════════════════════╝");
  dim(`${COUNT} sandboxes × ${CYCLES} cycles = ${COUNT * CYCLES} total cycles`);
  dim(`Concurrency: ${CONCURRENCY}\n`);

  const pool = createPool(CONCURRENCY);
  const promises = Array.from({ length: COUNT }, async (_, i) => {
    await pool.acquire();
    try {
      return await runHibernateWakeSoak(i);
    } finally {
      pool.release();
    }
  });

  const settled = await Promise.allSettled(promises);
  const results: HibernateWakeResult[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      index: i,
      sandboxId: "",
      markerPath: "",
      markerSha256: "",
      cycles: [],
      corrupted: false,
      error: r.reason?.message ?? String(r.reason),
      failedAt: "unknown",
    };
  });

  const totalCycles = results.reduce((sum, r) => sum + r.cycles.length, 0);
  const totalCorrupted = results.filter((r) => r.corrupted).length;
  const totalErrored = results.filter((r) => r.error).length;

  console.log();
  if (totalCorrupted > 0) {
    red(`Phase 2: ${totalCycles} cycles across ${COUNT} sandboxes, ${totalCorrupted} CORRUPTED`);
  } else {
    green(`Phase 2: ${totalCycles} cycles across ${COUNT} sandboxes, 0 corrupted`);
  }
  if (totalErrored > 0) {
    yellow(`  ${totalErrored} sandboxes errored (infra, not corruption)`);
  }

  // Timing stats
  const allCycles = results.flatMap((r) => r.cycles);
  if (allCycles.length > 0) {
    const hibTimes = allCycles.map((c) => c.hibernateMs);
    const wakeTimes = allCycles.map((c) => c.wakeMs);
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    dim(`  hibernate: avg=${formatMs(avg(hibTimes))} min=${formatMs(Math.min(...hibTimes))} max=${formatMs(Math.max(...hibTimes))}`);
    dim(`  wake:      avg=${formatMs(avg(wakeTimes))} min=${formatMs(Math.min(...wakeTimes))} max=${formatMs(Math.max(...wakeTimes))}`);
  }

  return { results, totalCycles, totalCorrupted, totalErrored };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  bold("╔══════════════════════════════════════════════════════════╗");
  bold("║     Snapshot Corruption Stress Test (v2)                 ║");
  bold("╚══════════════════════════════════════════════════════════╝");
  console.log();
  dim(`Phase 1: ${FORK_ROUNDS} fork blast rounds × ${FORKS_PER_ROUND} forks`);
  dim(`Phase 2: ${COUNT} sandboxes × ${CYCLES} hibernate/wake cycles`);
  dim(`Concurrency: ${CONCURRENCY}  Marker: ${MARKER_SIZE_MB}MB`);
  dim(`API: ${API_URL ?? "(default)"}`);
  console.log();

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Phase 1: Fork Blast
  let p1: TestReport["phase1_forkBlast"] = { rounds: [], totalForks: 0, totalCorrupted: 0 };
  if (FORK_ROUNDS > 0) {
    p1 = await phase1_forkBlast();
  } else {
    dim("Phase 1 skipped (--fork-rounds 0)");
  }

  // Phase 2: Hibernate/Wake Soak
  let p2: TestReport["phase2_hibernateWake"] = { results: [], totalCycles: 0, totalCorrupted: 0, totalErrored: 0 };
  if (COUNT > 0) {
    p2 = await phase2_hibernateWake();
  } else {
    dim("Phase 2 skipped (--count 0)");
  }

  const totalMs = Date.now() - startMs;
  const completedAt = new Date().toISOString();
  const anyCorruption = p1.totalCorrupted > 0 || p2.totalCorrupted > 0;

  // Final report
  console.log();
  bold("══════════════════════════════════════════════════════════");
  bold("  FINAL RESULTS");
  bold("══════════════════════════════════════════════════════════");
  console.log();

  const p1Tag = p1.totalCorrupted > 0 ? "\x1b[31m" : "\x1b[32m";
  const p2Tag = p2.totalCorrupted > 0 ? "\x1b[31m" : "\x1b[32m";
  console.log(`${p1Tag}  Phase 1 (fork blast):       ${p1.totalForks} forks / ${p1.totalCorrupted} corrupted\x1b[0m`);
  console.log(`${p2Tag}  Phase 2 (hibernate/wake):   ${p2.totalCycles} cycles / ${p2.totalCorrupted} corrupted\x1b[0m`);
  dim(`Total time: ${formatMs(totalMs)}`);
  console.log();

  // List all corruptions and errors
  const corruptedForks = p1.rounds.flatMap((r) =>
    r.forks.filter((f) => !f.markerVerified).map((f) => ({ round: r.round, ...f }))
  );
  const corruptedSoaks = p2.results.filter((r) => r.corrupted);
  const erroredSoaks = p2.results.filter((r) => r.error && !r.corrupted);

  if (corruptedForks.length > 0) {
    bold("  Fork blast corruptions:");
    for (const f of corruptedForks) {
      red(`    round ${f.round}: ${f.sandboxId} — ${f.error ?? "sha256 mismatch"}`);
    }
  }
  if (corruptedSoaks.length > 0) {
    bold("  Hibernate/wake corruptions:");
    for (const s of corruptedSoaks) {
      red(`    [${s.index}] ${s.sandboxId} — corrupted at cycle ${s.corruptedAtCycle}`);
    }
  }
  if (erroredSoaks.length > 0) {
    bold("  Hibernate/wake errors (not corruption):");
    for (const s of erroredSoaks) {
      yellow(`    [${s.index}] ${s.sandboxId || "no-id"} — ${s.failedAt}: ${s.error}`);
    }
  }

  // Build JSON report
  const report: TestReport = {
    startedAt,
    completedAt,
    config: {
      count: COUNT,
      concurrency: CONCURRENCY,
      cycles: CYCLES,
      forkRounds: FORK_ROUNDS,
      forksPerRound: FORKS_PER_ROUND,
      markerSizeMB: MARKER_SIZE_MB,
    },
    phase1_forkBlast: p1,
    phase2_hibernateWake: p2,
    summary: { totalDurationMs: totalMs, corruption: anyCorruption },
  };

  if (OUTPUT) {
    writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
    dim(`Report written to ${OUTPUT}`);
  }

  // Exit code
  if (anyCorruption) {
    red(`\nFAILED — corruption detected`);
    process.exit(1);
  } else if (p2.totalErrored > COUNT * 0.1) {
    yellow(`\nWARN — 0 corruptions but ${p2.totalErrored} errors (>${Math.round(COUNT * 0.1)} threshold)`);
    process.exit(2);
  } else {
    green(`\nPASSED — 0 corruptions`);
    process.exit(0);
  }
}

main().catch((err) => {
  red(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
