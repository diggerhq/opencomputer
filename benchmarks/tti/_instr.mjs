// Full instrumentation of the REAL SDK under burst.
//
// The TTI bench reports one number per iteration and captures no server-timing,
// so a slow burst is unattributable: "the platform got slower" and "the client
// queued" look identical. This wraps globalThis.fetch — which is what every SDK
// call resolves to — and records EVERY request the SDK makes:
//
//   start offset   when fetch() was CALLED, relative to the burst's t0
//   duration       how long it took
//   server-timing  the edge's own stage breakdown, inside that same request
//
// The start offsets are the discriminator. If 100 creates are all CALLED at
// t~=0 and return staggered, the queue is server-side. If they are called
// staggered, the client is the queue and no server fix will help.
import { Sandbox } from '@opencomputer/sdk';
import diagnostics from 'node:diagnostics_channel';

const N = parseInt(process.env.N ?? '100', 10);
const CMD = process.env.CMD ?? 'node -v';

// Connection-level truth. A request that is "slow" because it sat waiting for a
// socket is a client problem no server change can fix; one that is slow with a
// socket already in hand is not. undici publishes both, so we count them rather
// than argue about them.
const conn = { created: 0, connected: 0, failed: 0, connectMs: [] };
const connectStart = new Map();
try {
  diagnostics.subscribe('undici:client:connectStart', (e) => {
    connectStart.set(e, performance.now());
    conn.created++;
  });
  diagnostics.subscribe('undici:client:connected', (e) => {
    conn.connected++;
    const t = connectStart.get(e);
    if (t !== undefined) { conn.connectMs.push(performance.now() - t); connectStart.delete(e); }
  });
  diagnostics.subscribe('undici:client:connectError', () => { conn.failed++; });
} catch { /* channels unavailable — the fetch-level numbers still stand */ }

const calls = [];
let T0 = performance.now();

const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  const method = init?.method ?? 'GET';
  const started = performance.now();
  const rec = {
    method,
    path: url.replace(/^https?:\/\/[^/]+/, '').split('?')[0],
    start: started - T0,
    dur: -1,
    status: 0,
    timing: {},
  };
  calls.push(rec);
  try {
    const resp = await realFetch(input, init);
    rec.dur = performance.now() - started;
    rec.status = resp.status;
    const st = resp.headers.get('server-timing') ?? '';
    for (const part of st.split(',')) {
      const m = part.trim().match(/^([a-z0-9_]+);dur=([0-9.]+)/i);
      if (m) rec.timing[m[1]] = Number(m[2]);
    }
    return resp;
  } catch (e) {
    rec.dur = performance.now() - started;
    rec.status = -1;
    throw e;
  }
};

// Let the SDK's import-time prewarm settle so it is not racing the burst; those
// /health calls are recorded too and reported separately.
await new Promise((r) => setTimeout(r, 2000));

const iters = [];
async function one(i) {
  const t = { i, createStart: -1, create: -1, exec: -1, tti: -1, err: null };
  const s = performance.now();
  t.createStart = s - T0;
  let sb;
  try {
    sb = await Sandbox.create({});
    t.create = performance.now() - s;
    const e = performance.now();
    await sb.exec.run(CMD);
    t.exec = performance.now() - e;
    t.tti = performance.now() - s;
  } catch (err) {
    t.err = String(err).slice(0, 90);
  }
  iters.push(t);
  try { if (sb) await sb.destroy(); } catch {}
}

calls.length = 0; // drop prewarm noise from the window we analyse
T0 = performance.now();
const wall0 = performance.now();
// MODE=seq runs the SAME instrumentation one-at-a-time. That is the control the
// burst needs: identical client, identical marks, concurrency 1. Comparing the
// two stage-by-stage is what separates "a stage inflates under load" from "the
// whole path is uniformly slower".
if ((process.env.MODE ?? 'burst') === 'seq') {
  for (let i = 0; i < N; i++) await one(i);
} else {
  await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
}
const wall = performance.now() - wall0;

// ── report ────────────────────────────────────────────────────────────────
const f = (n) => (n < 0 ? '-' : n.toFixed(0));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * s.length)] ?? -1; };
const stat = (name, v) => v.length
  ? `${name.padEnd(16)} n=${String(v.length).padStart(4)} min ${f(Math.min(...v)).padStart(6)}  p50 ${f(q(v, .5)).padStart(6)}  p95 ${f(q(v, .95)).padStart(6)}  max ${f(Math.max(...v)).padStart(6)}`
  : `${name.padEnd(16)} —`;

const ok = iters.filter((x) => x.err === null);
console.log(`\n=== SDK burst N=${N} — ${ok.length}/${N} ok, wall ${f(wall)}ms ===\n`);
console.log('ITERATION (client-observed):');
console.log('  ' + stat('createStart', ok.map((x) => x.createStart)));
console.log('  ' + stat('create', ok.map((x) => x.create)));
console.log('  ' + stat('exec', ok.map((x) => x.exec)));
console.log('  ' + stat('tti', ok.map((x) => x.tti)));

const byPath = new Map();
for (const c of calls) {
  const k = `${c.method} ${c.path.replace(/\/sb-[a-z0-9]+/g, '/:id').replace(/\/[0-9a-f-]{20,}/g, '/:uuid')}`;
  if (!byPath.has(k)) byPath.set(k, []);
  byPath.get(k).push(c);
}
console.log(`\nREQUESTS the SDK actually made (${calls.length} total for ${N} iterations):`);
for (const [k, v] of [...byPath.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log('  ' + stat(k.slice(0, 16), v.map((c) => c.dur)) + `   [${k}]`);
  console.log('    ' + stat('  ↳ startOffset', v.map((c) => c.start)));
  const marks = new Set(v.flatMap((c) => Object.keys(c.timing)));
  for (const m of [...marks].sort()) {
    const vals = v.map((c) => c.timing[m]).filter((x) => x !== undefined);
    if (vals.length) console.log('    ' + stat(`  ↳ ${m}`, vals));
  }
}
console.log(`\nCONNECTIONS opened DURING the burst (client-side queueing):`);
console.log(`  new connections started=${conn.created} connected=${conn.connected} failed=${conn.failed}`);
if (conn.connectMs.length) console.log('  ' + stat('connect', conn.connectMs));
console.log(`  → ${conn.created} new sockets for ${calls.length} requests` +
  (conn.created > N * 0.5 ? '  ⚠ most requests paid a fresh connection' : '  (pool was reused)'));

// The ramp, stated directly: bucket every create by when it STARTED and show
// what it cost. A rising cost with flat start offsets is a server-side queue;
// rising start offsets are a client-side one.
const creates = calls.filter((c) => c.method === 'POST' && /\/sandboxes$/.test(c.path));
if (creates.length) {
  console.log('\nCREATE RAMP (deciles by start order):');
  const sorted = [...creates].sort((a, b) => a.start - b.start);
  const step = Math.max(1, Math.floor(sorted.length / 10));
  for (let i = 0; i < sorted.length; i += step) {
    const chunk = sorted.slice(i, i + step);
    const d = chunk.map((c) => c.dur);
    const cell = chunk.map((c) => c.timing.cell).filter((x) => x !== undefined);
    console.log(`  #${String(i).padStart(3)}-${String(Math.min(i + step, sorted.length) - 1).padStart(3)}` +
      `  start ${f(chunk[0].start).padStart(5)}-${f(chunk.at(-1).start).padStart(5)}ms` +
      `  dur p50 ${f(q(d, .5)).padStart(5)}ms` +
      (cell.length ? `  edge.cell p50 ${f(q(cell, .5)).padStart(4)}ms` : ''));
  }
}

const bad = calls.filter((c) => c.status >= 400 || c.status < 0);
if (bad.length) {
  const c2 = new Map();
  for (const b of bad) c2.set(`${b.status} ${b.path}`, (c2.get(`${b.status} ${b.path}`) ?? 0) + 1);
  console.log('\nNON-2xx:', [...c2.entries()].map(([k, n]) => `${k} ×${n}`).join(', '));
}
const errs = iters.filter((x) => x.err);
if (errs.length) console.log('\nITER ERRORS:', [...new Set(errs.map((e) => e.err))].slice(0, 5));
