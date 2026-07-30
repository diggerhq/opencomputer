#!/usr/bin/env node
/**
 * OpenComputer sandbox TTI benchmark — a standalone replica of the public
 * ComputeSDK leaderboard's "Sandbox TTI" benchmark
 * (github.com/computesdk/benchmarks, runs Fridays 00:00 UTC).
 *
 * It measures Time-to-Interactive: wall-clock from `sandbox.create()` through
 * the first `runCommand('node -v')` succeeding (destroy excluded), using the
 * SAME @computesdk/opencomputer adapter the leaderboard uses — so the numbers
 * here are what we should expect to post on Friday.
 *
 * Three modes, matching the leaderboard exactly:
 *   sequential  — one at a time            (concurrency 1)
 *   staggered   — ramp, 200ms between starts (concurrency 100)
 *   burst       — all at once              (concurrency 100)
 *
 * Stats + composite score are ported verbatim from the leaderboard:
 *   - trim bottom+top 5% of SUCCESSFUL runs, then median / P95 / P99
 *   - metricScore(v)   = max(0, 100 * (1 - v/10000ms))   (10s ceiling -> 0)
 *   - timingScore      = 0.60*median + 0.25*P95 + 0.15*P99  (all metricScore'd)
 *   - compositeScore   = round(timingScore * successRate * 100) / 100
 *
 * Config (env var, with --flag override). Defaults to PROD:
 *   OPENCOMPUTER_API_URL   default https://app.opencomputer.dev
 *   OPENCOMPUTER_API_KEY   required
 *   MODE       / --mode              sequential|staggered|burst|all   (default all)
 *   ITERATIONS / --iterations        default 100
 *   CONCURRENCY/ --concurrency       default 100 (staggered/burst; sequential is always 1)
 *   STAGGER_DELAY_MS / --stagger-delay-ms   default 200 (staggered only)
 *   JSON_OUT   / --json <path>        also write raw results as JSON
 *
 * Usage:
 *   OPENCOMPUTER_API_KEY=osb_xxx node bench.mjs                 # all modes, prod, 100 iters
 *   OPENCOMPUTER_API_KEY=osb_xxx node bench.mjs --mode sequential --iterations 20
 */
import { opencomputer } from '@computesdk/opencomputer';

// ---- config ---------------------------------------------------------------

function flag(name, envName, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  if (envName && process.env[envName] !== undefined && process.env[envName] !== '') return process.env[envName];
  return def;
}

const API_URL = flag('api-url', 'OPENCOMPUTER_API_URL', 'https://app.opencomputer.dev');
const API_KEY = flag('api-key', 'OPENCOMPUTER_API_KEY', '');
const MODE = String(flag('mode', 'MODE', 'all')).toLowerCase();
const ITERATIONS = parseInt(flag('iterations', 'ITERATIONS', '100'), 10);
const CONCURRENCY = parseInt(flag('concurrency', 'CONCURRENCY', '100'), 10);
const STAGGER_DELAY_MS = parseInt(flag('stagger-delay-ms', 'STAGGER_DELAY_MS', '200'), 10);
const JSON_OUT = flag('json', 'JSON_OUT', '');

// Per-op timeouts, matching the leaderboard's tti-task.ts.
const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_MS = 600_000; // sandboxOptions.timeout on the leaderboard

if (!API_KEY) {
  console.error('ERROR: OPENCOMPUTER_API_KEY is required (env var or --api-key).');
  process.exit(2);
}

// ---- helpers --------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} (>${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** One TTI iteration: create -> node -v (exit 0) -> destroy (untimed). */
async function ttiTask() {
  const compute = opencomputer({ apiKey: API_KEY, apiUrl: API_URL });
  const start = performance.now();
  const sandbox = await withTimeout(
    compute.sandbox.create({ timeout: KEEP_ALIVE_MS }),
    CREATE_TIMEOUT_MS,
    'create timed out',
  );
  try {
    const res = await withTimeout(sandbox.runCommand('node -v'), COMMAND_TIMEOUT_MS, 'command timed out');
    if (res.exitCode !== 0) {
      throw new Error(`node -v exit ${res.exitCode}: ${res.stderr || 'unknown'}`);
    }
    return performance.now() - start;
  } finally {
    await withTimeout(sandbox.destroy(), DESTROY_TIMEOUT_MS, 'destroy timed out').catch(() => {});
  }
}

/**
 * Run `iterations` TTI tasks with at most `concurrency` in flight, launching
 * successive tasks `staggerDelayMs` apart. sequential = {conc 1, delay 0},
 * staggered = {conc 100, delay 200}, burst = {conc 100, delay 0}.
 */
async function runMode(label, { iterations, concurrency, staggerDelayMs }) {
  process.stdout.write(
    `\n== ${label}: iterations=${iterations} concurrency=${concurrency} staggerDelayMs=${staggerDelayMs} ==\n`,
  );
  const oks = []; // ttiMs of successes
  let done = 0;
  let fails = 0;
  let active = 0;
  const queue = [];

  const runOne = async (i) => {
    active++;
    try {
      const ttiMs = await ttiTask();
      oks.push(ttiMs);
      process.stdout.write(`  [${++done + fails}/${iterations}] ok ${(ttiMs / 1000).toFixed(2)}s\n`);
    } catch (err) {
      fails++;
      process.stdout.write(`  [${done + fails}/${iterations}] FAIL ${err?.message || err}\n`);
    } finally {
      active--;
    }
  };

  // Dispatcher: respects the concurrency cap and the stagger between starts.
  for (let i = 0; i < iterations; i++) {
    while (active >= concurrency) await sleep(5);
    queue.push(runOne(i));
    if (staggerDelayMs > 0 && i < iterations - 1) await sleep(staggerDelayMs);
  }
  await Promise.all(queue);

  return summarize(label, { iterations, oks, fails });
}

// ---- stats + scoring (ported verbatim from the leaderboard) ---------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/** Trim bottom+top `trimPercent`, then compute stats on the remainder. */
function computeStats(values, trimPercent = 0.05) {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * trimPercent);
  const trimmed =
    trimCount > 0 && sorted.length - 2 * trimCount > 0
      ? sorted.slice(trimCount, sorted.length - trimCount)
      : sorted;
  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0 ? (trimmed[mid - 1] + trimmed[mid]) / 2 : trimmed[mid];
  const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  return {
    n: trimmed.length,
    min: trimmed[0],
    max: trimmed[trimmed.length - 1],
    mean,
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

const CEILING_MS = 10_000;
const scoreMetric = (v) => Math.max(0, 100 * (1 - v / CEILING_MS));

function compositeScore(stats, successRate) {
  if (successRate === 0) return 0;
  const timingScore =
    0.6 * scoreMetric(stats.median) + 0.25 * scoreMetric(stats.p95) + 0.15 * scoreMetric(stats.p99);
  return Math.round(timingScore * successRate * 100) / 100;
}

function summarize(mode, { iterations, oks, fails }) {
  const successRate = iterations > 0 ? oks.length / iterations : 0;
  const stats = computeStats(oks);
  const score = compositeScore(stats, successRate);
  return { mode, iterations, successes: oks.length, failures: fails, successRate, stats, score, raw: oks };
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function printSummary(results) {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`OpenComputer TTI benchmark  —  ${API_URL}`);
  console.log('='.repeat(78));
  const head = ['mode', 'ok/n', 'succ%', 'min', 'median', 'P95', 'P99', 'max', 'mean', 'score'];
  const rows = results.map((r) => [
    r.mode,
    `${r.successes}/${r.iterations}`,
    `${(r.successRate * 100).toFixed(0)}%`,
    fmt(r.stats.min),
    fmt(r.stats.median),
    fmt(r.stats.p95),
    fmt(r.stats.p99),
    fmt(r.stats.max),
    fmt(r.stats.mean),
    r.score.toFixed(2),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
  console.log('');
  console.log('score = 0.60·median + 0.25·P95 + 0.15·P99 (each vs 10s ceiling) × success-rate;');
  console.log('stats trim bottom+top 5% of successful runs (leaderboard methodology).');
}

// ---- main -----------------------------------------------------------------

const MODES = {
  sequential: { iterations: ITERATIONS, concurrency: 1, staggerDelayMs: 0 },
  staggered: { iterations: ITERATIONS, concurrency: CONCURRENCY, staggerDelayMs: STAGGER_DELAY_MS },
  burst: { iterations: ITERATIONS, concurrency: CONCURRENCY, staggerDelayMs: 0 },
};

const toRun = MODE === 'all' ? ['sequential', 'staggered', 'burst'] : [MODE];
for (const m of toRun) {
  if (!MODES[m]) {
    console.error(`ERROR: unknown mode "${m}" (want sequential|staggered|burst|all)`);
    process.exit(2);
  }
}

console.log(`OpenComputer TTI bench → ${API_URL}  (key ${API_KEY.slice(0, 6)}…)  modes=[${toRun.join(', ')}]`);

const results = [];
for (const m of toRun) {
  results.push(await runMode(m, MODES[m]));
}
printSummary(results);

if (JSON_OUT) {
  const fs = await import('node:fs');
  fs.writeFileSync(JSON_OUT, JSON.stringify({ apiUrl: API_URL, results }, null, 2));
  console.log(`\nwrote raw results → ${JSON_OUT}`);
}
