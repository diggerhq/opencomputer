// Pure client-transport probe: 100 concurrent POSTs to /health.
// No sandboxes, no pool. Isolates dispatcher cost (h2 vs h1.1, prewarm vs not).
const BASE = process.env.BASE ?? 'https://app2.opensandbox.ai';
const N = parseInt(process.env.N ?? '100', 10);
const MODE = process.env.TMODE ?? 'raw';       // raw | h2 | h2warm | h1warm
const PREWARM = parseInt(process.env.PW ?? '48', 10);

async function setup() {
  if (MODE === 'raw') return 'node-default (h1.1, no prewarm)';
  const { Agent, setGlobalDispatcher } = await import('undici');
  const allowH2 = MODE === 'h2' || MODE === 'h2warm' || MODE === 'race';
  setGlobalDispatcher(new Agent({
    allowH2,
    keepAliveTimeout: 600_000,
    keepAliveMaxTimeout: 600_000,
  }));
  if (MODE === 'race') {
    // Do NOT await: prewarm opens 48 connections WHILE the wave runs — exactly
    // what Sandbox.create() does with its fire-and-forget prewarmConnections().
    const ping = () => fetch(`${BASE}/health`, { method: 'POST' })
      .then(r => r.arrayBuffer()).catch(() => {});
    void Promise.all(Array.from({ length: PREWARM }, ping));
    return `undici allowH2=true + prewarm ${PREWARM} RACING the wave`;
  }
  if (MODE === 'h2warm' || MODE === 'h1warm') {
    const ping = () => fetch(`${BASE}/health`, { method: 'POST' })
      .then(r => r.arrayBuffer()).catch(() => {});
    await Promise.all(Array.from({ length: PREWARM }, ping));
    return `undici allowH2=${allowH2} + prewarm ${PREWARM}`;
  }
  return `undici allowH2=${allowH2}, no prewarm`;
}

const desc = await setup();

async function wave(label) {
  const t0 = performance.now();
  const lat = await Promise.all(Array.from({ length: N }, async () => {
    const s = performance.now();
    try { const r = await fetch(`${BASE}/health`, { method: 'POST' }); await r.arrayBuffer(); }
    catch { return -1; }
    return performance.now() - s;
  }));
  const wall = performance.now() - t0;
  const ok = lat.filter(x => x >= 0).sort((a, b) => a - b);
  const p = q => ok[Math.min(ok.length - 1, Math.floor(q * ok.length))] ?? -1;
  console.log(`${label.padEnd(8)} wall=${wall.toFixed(0)}ms  ok=${ok.length}/${N}  ` +
    `min=${(ok[0] ?? -1).toFixed(0)} p50=${p(0.5).toFixed(0)} p95=${p(0.95).toFixed(0)} max=${(ok.at(-1) ?? -1).toFixed(0)}`);
}

console.log(`\nmode=${MODE}  N=${N}  ${desc}`);
await wave('wave1');   // cold-ish (except when prewarmed)
await wave('wave2');   // fully warm — connections now exist in every mode
