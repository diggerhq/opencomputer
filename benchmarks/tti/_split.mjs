// Burst through the REAL SDK, timing create and exec legs separately.
// Answers: is SDK burst-100 slow in create, or in exec (inline-hold miss)?
import { Sandbox } from '@opencomputer/sdk';

const N = parseInt(process.env.N ?? '100', 10);
const rows = [];

async function one(i) {
  const t0 = performance.now();
  let sb, tCreate = -1, tExec = -1, err = null;
  try {
    sb = await Sandbox.create({});
    tCreate = performance.now() - t0;
    const t1 = performance.now();
    await sb.exec.run('node -v');
    tExec = performance.now() - t1;
  } catch (e) { err = String(e).slice(0, 80); }
  rows.push({ i, tCreate, tExec, tti: tCreate < 0 ? -1 : tCreate + tExec, err });
  try { if (sb) await sb.destroy(); } catch {}
}

const t = performance.now();
await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const wall = performance.now() - t;

const ok = rows.filter(r => r.err === null);
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * s.length)] ?? -1; };
const f = n => n.toFixed(0);
console.log(`\nwall=${f(wall)}ms ok=${ok.length}/${N}`);
for (const [k, label] of [['tCreate', 'create'], ['tExec', 'exec'], ['tti', 'TTI']]) {
  const v = ok.map(r => r[k]);
  console.log(`${label.padEnd(7)} min=${f(Math.min(...v))} p50=${f(q(v, .5))} p95=${f(q(v, .95))} max=${f(Math.max(...v))}`);
}
const errs = rows.filter(r => r.err).map(r => r.err);
if (errs.length) console.log('errors:', [...new Set(errs)].slice(0, 5));
