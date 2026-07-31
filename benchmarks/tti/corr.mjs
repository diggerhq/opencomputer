#!/usr/bin/env node
/**
 * Correlation harness: fire a burst of concurrent creates, and for EACH request
 * record (a) when it was actually sent relative to burst t0 (sendOffset), (b) its
 * client wall-time (createMs), and (c) the sandbox id. Then grep the CP TIMING
 * logs for each id to see server-side `total` — so we can locate where the burst
 * latency lives (client/edge queue vs server).
 *
 *   OPENCOMPUTER_API_KEY=osb_xxx node corr.mjs [--concurrency 20]
 */
import { opencomputer } from '@computesdk/opencomputer';

const flag = (n, e, d) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return process.env[e] ?? d;
};
const API_URL = flag('api-url', 'OPENCOMPUTER_API_URL', 'https://app.opencomputer.dev');
const API_KEY = flag('api-key', 'OPENCOMPUTER_API_KEY', '');
const CONC = parseInt(flag('concurrency', 'CONCURRENCY', '20'), 10);
if (!API_KEY) { console.error('OPENCOMPUTER_API_KEY required'); process.exit(2); }

if (process.env.HICONN) {
  const { setGlobalDispatcher, Agent } = await import('undici');
  setGlobalDispatcher(new Agent({ connections: 256, pipelining: 0 }));
  console.log('(undici hi-conn dispatcher: 256 connections)');
}

const now = () => performance.now();
const idOf = (s) => s?.sandboxId ?? s?.id ?? s?.sandbox?.sandboxId ?? s?.data?.sandboxId ?? 'unknown';

const t0 = now();
const tasks = [];
for (let i = 0; i < CONC; i++) {
  tasks.push((async () => {
    const compute = opencomputer({ apiKey: API_KEY, apiUrl: API_URL });
    const sendOffset = now() - t0;
    const s0 = now();
    try {
      const sandbox = await compute.sandbox.create({ timeout: 600_000 });
      const createMs = now() - s0;
      const id = idOf(sandbox);
      sandbox.destroy().catch(() => {});
      return { i, id, sendOffset, createMs, ok: true };
    } catch (e) {
      return { i, id: 'ERR', sendOffset, createMs: now() - s0, ok: false, err: String(e?.message || e) };
    }
  })());
}
const res = (await Promise.all(tasks)).sort((a, b) => a.createMs - b.createMs);

// dump keys of nothing here; just print rows
console.log(`burst conc=${CONC} → ${API_URL}\n`);
console.log('  idx  sendOffset  createMs   id');
for (const r of res) {
  console.log(
    `  ${String(r.i).padStart(3)}  ${String(Math.round(r.sendOffset)).padStart(7)}ms  ${String(Math.round(r.createMs)).padStart(6)}ms   ${r.id}${r.ok ? '' : '  ERR:' + r.err}`,
  );
}
const cs = res.filter((r) => r.ok).map((r) => r.createMs).sort((a, b) => a - b);
const pct = (q) => Math.round(cs[Math.min(cs.length - 1, Math.ceil(q * cs.length) - 1)]);
console.log(`\n  client createMs: min=${Math.round(cs[0])} med=${pct(0.5)} p95=${pct(0.95)} max=${Math.round(cs[cs.length - 1])}`);
console.log(`  ids: ${res.filter((r) => r.ok).map((r) => r.id).join(' ')}`);
