#!/usr/bin/env node
/**
 * Burst diagnostic: same workload as bench.mjs (create -> node -v -> destroy)
 * but times each PHASE separately, so we can see where the ~8s under
 * 100-concurrency actually goes (provisioning vs first-command exec).
 *
 *   OPENCOMPUTER_API_KEY=osb_xxx node diag.mjs [--iterations 100] [--concurrency 100]
 */
import { opencomputer } from '@computesdk/opencomputer';

const flag = (n, e, d) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return process.env[e] ?? d;
};
const API_URL = flag('api-url', 'OPENCOMPUTER_API_URL', 'https://app.opencomputer.dev');
const API_KEY = flag('api-key', 'OPENCOMPUTER_API_KEY', '');
const ITER = parseInt(flag('iterations', 'ITERATIONS', '100'), 10);
const CONC = parseInt(flag('concurrency', 'CONCURRENCY', '100'), 10);
if (!API_KEY) { console.error('OPENCOMPUTER_API_KEY required'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

async function one() {
  const compute = opencomputer({ apiKey: API_KEY, apiUrl: API_URL });
  const t0 = now();
  const sandbox = await compute.sandbox.create({ timeout: 600_000 });
  const t1 = now();
  let cmdOk = false;
  try {
    const r = await sandbox.runCommand('node -v');
    cmdOk = r.exitCode === 0;
  } catch { /* record as fail */ }
  const t2 = now();
  sandbox.destroy().catch(() => {});
  return { createMs: t1 - t0, execMs: t2 - t1, ok: cmdOk };
}

function stats(a) {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const pct = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return { n: s.length, min: s[0], med: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: s[s.length - 1] };
}
const f = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const row = (label, st) =>
  console.log(`  ${label.padEnd(8)} n=${st.n}  min=${f(st.min)}  med=${f(st.med)}  p95=${f(st.p95)}  p99=${f(st.p99)}  max=${f(st.max)}`);

console.log(`burst diag → ${API_URL}  iterations=${ITER} concurrency=${CONC}\n`);
const results = [];
let active = 0;
const q = [];
for (let i = 0; i < ITER; i++) {
  while (active >= CONC) await sleep(5);
  active++;
  q.push(
    one()
      .then((r) => results.push(r))
      .catch((e) => results.push({ createMs: NaN, execMs: NaN, ok: false, err: String(e?.message || e) }))
      .finally(() => active--),
  );
}
await Promise.all(q);

const ok = results.filter((r) => r.ok);
console.log(`success ${ok.length}/${results.length}\n`);
row('create', stats(results.map((r) => r.createMs).filter((x) => !isNaN(x))));
row('exec', stats(ok.map((r) => r.execMs)));
row('total', stats(ok.map((r) => r.createMs + r.execMs)));
