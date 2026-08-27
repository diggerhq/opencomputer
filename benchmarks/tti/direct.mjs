#!/usr/bin/env node
/**
 * DIRECT-API TTI harness — the control for bench.mjs.
 *
 * Same TTI definition as bench.mjs (create -> `node -v` exit 0, destroy
 * untimed), same concurrency model, same endpoints and wire bodies as
 * @opencomputer/sdk. The ONLY difference is that this speaks raw fetch instead
 * of going through the SDK object graph.
 *
 * It exists because a direct harness reportedly scored ~300ms on a burst where
 * the SDK scored ~1s against the same backend. If that reproduces here, the
 * penalty is in the client, not the platform — and every server-side mark we
 * have would be blind to it, because they all start their clock at handler
 * entry (see index.ts, the `tPrev` note).
 *
 * The instrumentation that matters is per-iteration REQUEST COUNT and
 * client-side sleep, because that is precisely what the SDK adds:
 * exec.run() short-circuits only when the response carries no execId
 * (exec.js:297). Otherwise it polls — an immediate /result, then sleep 50,
 * 100, 200... on a single Node event loop, which is exactly the thing that
 * degrades when 100 tasks share that loop.
 *
 *   OPENCOMPUTER_API_KEY=osb_xxx node direct.mjs --api-url https://app2.opensandbox.ai \
 *     --mode burst --iterations 100 --concurrency 100
 */

const flag = (n, e, d) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return process.env[e] ?? d;
};
const RAW_URL = flag('api-url', 'OPENCOMPUTER_API_URL', 'https://app.opencomputer.dev');
const BASE = RAW_URL.replace(/\/+$/, '');
const API = BASE.endsWith('/api') ? BASE : `${BASE}/api`;
const API_KEY = flag('api-key', 'OPENCOMPUTER_API_KEY', '');
const MODE = flag('mode', 'MODE', 'sequential');
const ITER = parseInt(flag('iterations', 'ITERATIONS', '12'), 10);
if (!API_KEY) {
  console.error('OPENCOMPUTER_API_KEY is required (env var or --api-key).');
  process.exit(2);
}

// Match bench.mjs's mode table exactly so the two are comparable.
const MODES = {
  sequential: { concurrency: 1, stagger: 0 },
  staggered: { concurrency: 100, stagger: 200 },
  burst: { concurrency: 100, stagger: 0 },
};
const modeCfg = MODES[MODE] ?? MODES.sequential;
const CONC = parseInt(flag('concurrency', 'CONCURRENCY', String(modeCfg.concurrency)), 10);
const STAGGER = parseInt(flag('stagger', 'STAGGER', String(modeCfg.stagger)), 10);

const KEEP_ALIVE_MS = 600_000;
const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;

const HEADERS = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// Per-iteration counters. `requests` is the headline: the SDK's poll ladder
// shows up here as >2, and nowhere in any server-timing mark.
const stats = { requests: [], sleptMs: [], polls: [] };

async function jfetch(url, init) {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function createSandbox() {
  return jfetch(`${API}/sandboxes`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ templateID: 'base', timeout: KEEP_ALIVE_MS }),
  });
}

/**
 * Byte-for-byte the SDK's run() contract, including the inline short-circuit
 * and the backoff ladder, so a difference in the numbers cannot be blamed on
 * this harness taking a cheaper path than the SDK does.
 */
async function runCommand(id, command, counters) {
  const handle = await jfetch(`${API}/sandboxes/${id}/exec/run-async`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ cmd: 'sh', args: ['-c', command], timeout: 60 }),
  });
  counters.requests++;
  // Inline result: the edge's VM-DO fast path answers in the run-async shape
  // with no execId, and the SDK returns here without ever polling.
  if (handle.execId == null && handle.exitCode != null) return handle;

  const execId = handle.execId;
  let delay = 50;
  for (;;) {
    const result = await jfetch(`${API}/sandboxes/${id}/exec/${execId}/result`, { headers: HEADERS });
    counters.requests++;
    counters.polls++;
    if (!result.running) return result;
    await sleep(delay);
    counters.sleptMs += delay;
    delay = Math.min(delay * 2, 2000);
  }
}

async function destroy(id) {
  await fetch(`${API}/sandboxes/${id}`, { method: 'DELETE', headers: HEADERS }).catch(() => {});
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(msg)), ms);
    }),
  ]);
}

async function ttiTask() {
  const counters = { requests: 0, polls: 0, sleptMs: 0 };
  const start = now();
  let box;
  try {
    box = await withTimeout(createSandbox(), CREATE_TIMEOUT_MS, 'create timed out');
    counters.requests++;
    const id = box.sandboxID ?? box.sandboxId ?? box.id ?? box.sandbox_id;
    if (!id) throw new Error(`create returned no id: ${JSON.stringify(box).slice(0, 200)}`);
    const res = await withTimeout(runCommand(id, 'node -v', counters), COMMAND_TIMEOUT_MS, 'command timed out');
    if (res.exitCode !== 0) throw new Error(`node -v exit ${res.exitCode}: ${res.stderr || 'unknown'}`);
    const ms = now() - start;
    stats.requests.push(counters.requests);
    stats.polls.push(counters.polls);
    stats.sleptMs.push(counters.sleptMs);
    return ms;
  } finally {
    const id = box?.sandboxID ?? box?.sandboxId ?? box?.id ?? box?.sandbox_id;
    if (id) await destroy(id);
  }
}

async function runMode() {
  const results = [];
  let launched = 0;
  const inFlight = new Set();
  while (launched < ITER || inFlight.size > 0) {
    while (launched < ITER && inFlight.size < CONC) {
      const idx = ++launched;
      const p = ttiTask()
        .then((ms) => {
          results.push(ms);
          process.stdout.write(`  [${idx}/${ITER}] ok ${(ms / 1000).toFixed(2)}s\n`);
        })
        .catch((e) => {
          process.stdout.write(`  [${idx}/${ITER}] FAIL ${e.message}\n`);
        })
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (STAGGER > 0) await sleep(STAGGER);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
  return results;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

(async () => {
  process.stdout.write(`DIRECT-API TTI → ${API}  (key ${API_KEY.slice(0, 6)}…)  mode=${MODE} conc=${CONC}\n`);
  process.stdout.write(`== ${MODE}: iterations=${ITER} concurrency=${CONC} stagger=${STAGGER}ms ==\n`);
  const t0 = now();
  const results = await runMode();
  const wall = now() - t0;
  const sorted = [...results].sort((a, b) => a - b);
  process.stdout.write('\n' + '='.repeat(78) + '\n');
  process.stdout.write(`DIRECT-API TTI  —  ${API}\n`);
  process.stdout.write('='.repeat(78) + '\n');
  process.stdout.write(
    `mode        ok/n    succ%  min    median  P95    P99    max    mean\n` +
      `${MODE.padEnd(11)} ${String(results.length).padStart(3)}/${String(ITER).padEnd(4)} ` +
      `${String(Math.round((results.length / ITER) * 100)).padStart(4)}%  ` +
      `${fmt(sorted[0] ?? 0).padEnd(6)} ${fmt(pct(sorted, 50)).padEnd(7)} ${fmt(pct(sorted, 95)).padEnd(6)} ` +
      `${fmt(pct(sorted, 99)).padEnd(6)} ${fmt(sorted[sorted.length - 1] ?? 0).padEnd(6)} ${fmt(mean(results))}\n`,
  );
  // The client-shape numbers. These are the ones the server cannot see.
  const reqs = [...stats.requests].sort((a, b) => a - b);
  const slept = [...stats.sleptMs].sort((a, b) => a - b);
  process.stdout.write(
    `\n  client shape: requests/iter p50=${pct(reqs, 50)} max=${pct(reqs, 100)}` +
      `  polls/iter p50=${pct([...stats.polls].sort((a, b) => a - b), 50)}` +
      `  client sleep p50=${pct(slept, 50)}ms max=${pct(slept, 100)}ms\n`,
  );
  process.stdout.write(`  wall ${fmt(wall)}\n`);
})();
