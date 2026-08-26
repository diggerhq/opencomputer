// A complete ledger for one create. Every millisecond gets a named home and the
// segments SUM TO TOTAL — there is no residual bucket, on purpose. We are
// hunting time; a bucket called "other" is where the answer goes to hide, and it
// has already hidden there twice.
//
// Four hypotheses have died against real measurements: TLS handshakes (batching
// 26 creates into one request moved `cell` 126->132ms), CP compute (42us),
// edge CPU (p50 1ms), and distance (constant; cannot explain 4x between
// sequential and burst on one path). What is left has to be somewhere in here.
//
// THE LEDGER (client clock unless noted):
//
//   connect       DNS + TCP + TLS.        undici diagnostics.        DIRECT
//   req_wire      client -> colo.         derived from RTT.          DERIVED
//   colo_admit    bytes at colo -> our handler starts running.       DERIVED
//   hdl           handler entry -> return. edge clock.               DIRECT
//     auth/ctx/gatecell/capmint   existing marks.                    DIRECT
//     cell        edge's fetch to the CP, round trip.                DIRECT
//       cp_total  CP handler, CP clock, joined by sandboxID.         DIRECT
//       cp_wire   cell - cp_total: edge<->CP network + CP admission. DIRECT
//     hdl_other   hdl minus its own marks. edge clock.               DIRECT
//   resp_wire     handler returns -> client sees headers.            DERIVED
//   body_read     headers -> body complete.                          DIRECT
//
// WHY THE DERIVED ONES ARE NOT GUESSES. Every DIRECT quantity is a difference of
// two readings taken by the SAME machine, so clock skew cancels and no NTP
// assumption enters anywhere. For the wire, TLS 1.3 completes in about two round
// trips, so a socket we actually open measures the path's RTT for us — we do not
// have to assume it. req_wire and resp_wire each take half. What remains after
// subtracting everything measured is colo_admit, and that is a real physical
// interval (bytes have arrived at Cloudflare; our code has not been given a CPU
// yet), not a write-off. It is also the only load-DEPENDENT term: wire and TLS
// do not care how many requests are in flight, contention does. That is what
// makes the sequential run the control — run both and colo_admit is the term
// that moves.
import diagnostics from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";

const BASE = process.env.OPENCOMPUTER_API_URL ?? "https://app2.opensandbox.ai";
const KEY = process.env.OPENCOMPUTER_API_KEY;
const N = Number(process.env.N ?? 100);
const MODE = process.env.MODE ?? "burst";
const OUT = process.env.OUT ?? "/tmp/ledger.ndjson";
if (!KEY) { console.error("set OPENCOMPUTER_API_KEY"); process.exit(1); }

// ── connect timing, straight from undici ──────────────────────────────────
const connects = [];
const startedAt = new Map();
try {
  diagnostics.subscribe("undici:client:connectStart", (e) => startedAt.set(e, performance.now()));
  diagnostics.subscribe("undici:client:connected", (e) => {
    const t = startedAt.get(e);
    if (t !== undefined) { connects.push(performance.now() - t); startedAt.delete(e); }
  });
} catch { /* fall back to assuming reuse; reported as such */ }

function parseTiming(h) {
  const out = {};
  for (const p of (h ?? "").split(",")) {
    const m = p.trim().match(/^([a-z0-9_]+);dur=([0-9.]+)/i);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

async function one(i) {
  const t0 = performance.now();
  const r = { i, status: 0, id: null, total: -1, headers: -1, body_read: -1, timing: {} };
  try {
    const resp = await fetch(BASE + "/api/sandboxes", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: "{}",
    });
    // fetch resolves on HEADERS. Timing this separately from the body split the
    // return leg instead of lumping transit and read together.
    r.headers = performance.now() - t0;
    const text = await resp.text();
    r.total = performance.now() - t0;
    r.body_read = r.total - r.headers;
    r.status = resp.status;
    r.timing = parseTiming(resp.headers.get("server-timing"));
    r.colo = (resp.headers.get("cf-ray") ?? "").split("-")[1] ?? "?";
    try { r.id = JSON.parse(text).sandboxID ?? null; } catch { r.err = text.slice(0, 100); }
  } catch (e) {
    r.total = performance.now() - t0; r.status = -1; r.err = String(e).slice(0, 100);
  }
  return r;
}

const wall0 = performance.now();
let recs;
if (MODE === "seq") { recs = []; for (let i = 0; i < N; i++) recs.push(await one(i)); }
else recs = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const wall = performance.now() - wall0;

const ok = recs.filter((r) => r.status === 201 && r.id);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const f = (n) => n.toFixed(1);

// RTT, measured directly rather than inferred. A TCP connect to the same host
// and port is exactly one round trip (SYN -> SYN/ACK), so this is the cleanest
// possible reading of the wire and it does not depend on anyone's reporting.
// Sampled several times and taken at the median so a single scheduling hiccup
// cannot set the floor for the whole ledger.
//
// This matters because if RTT were left at zero, the wire would silently fall
// into colo_admit and we would "find" queueing that was really just the network.
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
const rtt = await measureRTT(new URL(BASE).hostname, 443);
const connectP50 = connects.length ? q(connects, 0.5) : 0;

// Build the per-request ledger. colo_admit is defined as the remainder so the
// column sums to total EXACTLY — that identity is the point: nothing is dropped.
for (const r of ok) {
  const t = r.timing;
  r.seg = {
    connect: connects.length ? connectP50 : 0,
    req_wire: rtt / 2,
    resp_wire: rtt / 2,
    hdl: t.hdl ?? 0,
    body_read: r.body_read,
  };
  r.seg.colo_admit = r.total - (r.seg.connect + r.seg.req_wire + r.seg.resp_wire + r.seg.hdl + r.seg.body_read);
  r.hdl_marks = {
    auth: t.auth ?? 0, ctx: t.ctx ?? 0, gatecell: t.gatecell ?? 0,
    capmint: t.capmint ?? 0, cell: t.cell ?? 0, cellbody: t.cellbody ?? 0,
  };
  const named = Object.values(r.hdl_marks).reduce((a, b) => a + b, 0);
  r.hdl_marks.hdl_other = (t.hdl ?? 0) - named;
}

console.log(`\n=== LEDGER ${MODE} N=${N} — ${ok.length}/${N} ok, wall ${f(wall)}ms ===`);
console.log(`TCP RTT to origin (median of 7 direct connects): ${f(rtt)}ms   [sockets opened this run: ${connects.length}, p50 handshake ${f(connectP50)}ms]\n`);

const SEGS = ["connect", "req_wire", "colo_admit", "hdl", "resp_wire", "body_read"];
console.log("SEGMENT           p50        p95        share(p50)");
const totP50 = q(ok.map((r) => r.total), 0.5);
for (const s of SEGS) {
  const v = ok.map((r) => r.seg[s]);
  console.log(`  ${s.padEnd(14)} ${f(q(v, 0.5)).padStart(7)}ms ${f(q(v, 0.95)).padStart(8)}ms   ${((q(v, 0.5) / totP50) * 100).toFixed(0).padStart(3)}%`);
}
console.log(`  ${"TOTAL".padEnd(14)} ${f(totP50).padStart(7)}ms ${f(q(ok.map((r) => r.total), 0.95)).padStart(8)}ms   100%`);
const sumP50 = SEGS.reduce((a, s) => a + q(ok.map((r) => r.seg[s]), 0.5), 0);
console.log(`  (segments sum ${f(sumP50)}ms vs total ${f(totP50)}ms — per-request identity is exact)`);

console.log("\nINSIDE hdl (edge clock):");
for (const k of ["auth", "ctx", "gatecell", "capmint", "cell", "cellbody", "hdl_other"]) {
  const v = ok.map((r) => r.hdl_marks[k]);
  console.log(`  ${k.padEnd(14)} ${f(q(v, 0.5)).padStart(7)}ms ${f(q(v, 0.95)).padStart(8)}ms`);
}

console.log("\ncolos:", Object.entries(ok.reduce((a, r) => ((a[r.colo] = (a[r.colo] ?? 0) + 1), a), {})).map(([k, v]) => `${k}=${v}`).join(" "));
const bad = recs.filter((r) => r.status !== 201);
if (bad.length) console.log(`NON-201: ${bad.length}`, [...new Set(bad.map((b) => `${b.status} ${(b.err ?? "").slice(0, 60)}`))].slice(0, 3));

writeFileSync(OUT, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nwrote ${recs.length} -> ${OUT}  (join cell vs cp_total by sandboxID from the CP journal)`);

await Promise.all(ok.map((r) => fetch(`${BASE}/api/sandboxes/${r.id}`, { method: "DELETE", headers: { "x-api-key": KEY } }).catch(() => {})));
console.log(`destroyed ${ok.length}`);
