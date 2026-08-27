// The same ledger, but driven by the REAL SDK — because the raw-fetch ledger
// answers "where does a create spend its time", and the question that actually
// matters is "where does the BENCHMARK's time go". Those differ: the SDK adds
// its own client, its own connection pool, and an exec leg the raw harness never
// touches.
//
// Method is identical to _ledger.mjs: every segment is a difference of two
// readings taken by the same machine, RTT is measured directly with a TCP
// connect, and the segments sum to the total. Nothing is written off.
//
// The one addition is scope. The raw ledger measured create only; the benchmark
// measures create + exec, so both legs get their own ledger here and the TTI is
// reported as the sum the leaderboard would see.
import diagnostics from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import { Sandbox } from "@opencomputer/sdk";

const BASE = process.env.OPENCOMPUTER_API_URL ?? "https://app2.opensandbox.ai";
const N = Number(process.env.N ?? 100);
const MODE = process.env.MODE ?? "burst";
const CMD = process.env.CMD ?? "node -v";
const OUT = process.env.OUT ?? "/tmp/ledger_sdk.ndjson";

const connects = [];
const startedAt = new Map();
try {
  diagnostics.subscribe("undici:client:connectStart", (e) => startedAt.set(e, performance.now()));
  diagnostics.subscribe("undici:client:connected", (e) => {
    const t = startedAt.get(e);
    if (t !== undefined) { connects.push(performance.now() - t); startedAt.delete(e); }
  });
} catch { /* reported as zero sockets below */ }

function parseTiming(h) {
  const out = {};
  for (const p of (h ?? "").split(",")) {
    const m = p.trim().match(/^([a-z0-9_]+);dur=([0-9.]+)/i);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// Wrap fetch to capture per-request server-timing and the headers/body split.
// The SDK calls global fetch, so this sees exactly what the SDK sees — no
// parallel code path that might behave differently under load.
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const t0 = performance.now();
  const rec = { path: url.replace(/^https?:\/\/[^/]+/, "").split("?")[0], method: init?.method ?? "GET", start: t0, headers: -1, total: -1, timing: {}, status: 0 };
  calls.push(rec);
  const resp = await realFetch(input, init);
  rec.headers = performance.now() - t0;
  rec.status = resp.status;
  rec.timing = parseTiming(resp.headers.get("server-timing"));
  rec.colo = (resp.headers.get("cf-ray") ?? "").split("-")[1] ?? "?";
  // Read the body through a clone so the SDK still gets an unconsumed stream.
  const clone = resp.clone();
  void clone.text().then(() => { rec.total = performance.now() - t0; }).catch(() => {});
  return resp;
};

async function measureRTT(host, port, samples = 7) {
  const { connect } = await import("node:net");
  const out = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await new Promise((res) => {
      const s = connect({ host, port }, () => { out.push(performance.now() - t); s.destroy(); res(); });
      s.on("error", () => { s.destroy(); res(); });
      s.setTimeout(3000, () => { s.destroy(); res(); });
    });
  }
  return out.length ? out.sort((a, b) => a - b)[Math.floor(out.length / 2)] : 0;
}

const iters = [];
async function one(i) {
  const t = { i, create: -1, exec: -1, tti: -1, err: null };
  const s = performance.now();
  let sb;
  try {
    sb = await Sandbox.create({});
    t.create = performance.now() - s;
    const e = performance.now();
    await sb.exec.run(CMD);
    t.exec = performance.now() - e;
    t.tti = performance.now() - s;
  } catch (err) { t.err = String(err).slice(0, 90); }
  iters.push(t);
  // kill(), NOT destroy() — the SDK has no destroy method, so this line used to
  // throw into the swallowing catch below and leak EVERY sandbox the run made.
  // 100 boxes per burst, silently, while the run reported success. Log failures
  // rather than swallowing them: a teardown that fails quietly is how a
  // benchmark ends up measuring a fleet 2x over its own box ceiling.
  try { if (sb) await sb.kill(); } catch (e) { console.error("LEAK: kill failed for", t.i, String(e).slice(0, 80)); }
}

// Let the SDK's import-time connection prewarm finish so it is not racing the
// measurement; those requests are dropped from the window below.
await new Promise((r) => setTimeout(r, 2000));
const rtt = await measureRTT(new URL(BASE).hostname, 443);
calls.length = 0;
connects.length = 0;

const wall0 = performance.now();
if (MODE === "seq") { for (let i = 0; i < N; i++) await one(i); }
else await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const wall = performance.now() - wall0;

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const f = (n) => n.toFixed(1);
const ok = iters.filter((x) => x.err === null);

console.log(`\n=== SDK LEDGER ${MODE} N=${N} — ${ok.length}/${N} ok, wall ${f(wall)}ms ===`);
console.log(`TCP RTT (median of 7 direct connects): ${f(rtt)}ms   [sockets opened during run: ${connects.length}]\n`);
console.log("AS THE BENCHMARK SEES IT:");
console.log(`  create   p50 ${f(q(ok.map((x) => x.create), 0.5)).padStart(7)}ms   p95 ${f(q(ok.map((x) => x.create), 0.95)).padStart(7)}ms`);
console.log(`  exec     p50 ${f(q(ok.map((x) => x.exec), 0.5)).padStart(7)}ms   p95 ${f(q(ok.map((x) => x.exec), 0.95)).padStart(7)}ms`);
console.log(`  TTI      p50 ${f(q(ok.map((x) => x.tti), 0.5)).padStart(7)}ms   p95 ${f(q(ok.map((x) => x.tti), 0.95)).padStart(7)}ms`);

// Per-endpoint ledger. colo_admit is the remainder, so each row closes exactly.
const groups = new Map();
for (const c of calls) {
  const k = `${c.method} ${c.path.replace(/\/sb-[a-z0-9]+/g, "/:id")}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(c);
}
for (const [k, v] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const done = v.filter((c) => c.headers >= 0);
  if (!done.length) continue;
  const seg = done.map((c) => {
    const hdl = c.timing.hdl ?? c.timing.origin ?? 0;
    return { total: c.headers, hdl, wire: rtt, colo_admit: c.headers - hdl - rtt };
  });
  console.log(`\n${k}   n=${done.length}`);
  console.log(`  total(headers) p50 ${f(q(seg.map((s) => s.total), 0.5)).padStart(7)}ms`);
  console.log(`  wire           p50 ${f(rtt).padStart(7)}ms`);
  console.log(`  hdl (edge)     p50 ${f(q(seg.map((s) => s.hdl), 0.5)).padStart(7)}ms`);
  console.log(`  colo_admit     p50 ${f(q(seg.map((s) => s.colo_admit), 0.5)).padStart(7)}ms   <-- queued before our code ran`);
  const marks = [...new Set(done.flatMap((c) => Object.keys(c.timing)))].sort();
  const detail = marks.map((m) => `${m}=${f(q(done.map((c) => c.timing[m] ?? 0), 0.5))}`).join(" ");
  if (detail) console.log(`  marks p50: ${detail}`);
}

const colos = calls.reduce((a, c) => (c.colo ? ((a[c.colo] = (a[c.colo] ?? 0) + 1), a) : a), {});
console.log("\ncolos:", Object.entries(colos).map(([k, v]) => `${k}=${v}`).join(" "));
const errs = iters.filter((x) => x.err);
if (errs.length) console.log("ERRORS:", [...new Set(errs.map((e) => e.err))].slice(0, 3));

writeFileSync(OUT, JSON.stringify({ rtt, iters, calls }, null, 0));
console.log(`\nwrote -> ${OUT}`);
