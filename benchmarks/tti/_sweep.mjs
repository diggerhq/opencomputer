// Does colo_admit belong to Cloudflare, or is some of it our own client?
//
// colo_admit is a DERIVED term (total - hdl - rtt - body_read), so anything the
// client does between "we called fetch" and "the bytes left the NIC" lands in it
// silently. That is exactly the write-off we refuse to make, so it has to be
// excluded by measurement, not by argument. Two independent tests:
//
// TEST A -- does it scale with N? Client-side send queueing and Cloudflare
// admission both grow with concurrency, so this alone does not separate them --
// but the SHAPE does. Client queueing through a fixed connection pool is a
// step function in N/poolsize; colo admission is smoother. And if colo_admit
// were flat in N it would be neither, which would falsify the whole finding.
//
// TEST B -- the real discriminator. Run the same N with each request on its OWN
// undici Agent (its own connection pool, its own socket). If colo_admit is
// client-side pool contention it collapses; if it is Cloudflare it does not
// move. Sockets are counted with an explicit connect hook rather than the
// diagnostics channel, which silently reported `sockets opened: 0` last time and
// so proved nothing.
import { writeFileSync } from "node:fs";
import { Agent, buildConnector, fetch as uFetch } from "undici";

const BASE = process.env.OPENCOMPUTER_API_URL ?? "https://app2.opensandbox.ai";
const KEY = process.env.OPENCOMPUTER_API_KEY;
const LEVELS = (process.env.LEVELS ?? "10,25,50,100").split(",").map(Number);
const OUT = process.env.OUT ?? "/tmp/sweep.ndjson";
if (!KEY) { console.error("set OPENCOMPUTER_API_KEY"); process.exit(1); }

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const f = (n) => n.toFixed(1);

function parseTiming(h) {
  const out = {};
  for (const p of (h ?? "").split(",")) {
    const m = p.trim().match(/^([a-z0-9_]+);dur=([0-9.]+)/i);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// Count sockets for real, by wrapping undici's own connector. Every new
// connection goes through here by construction, so unlike the diagnostics
// channel this cannot silently report zero and leave the wire unaccounted for.
let socketsOpened = 0;
let connectMs = [];
const baseConnector = buildConnector({});
const countingConnector = (opts, cb) => {
  const t = performance.now();
  return baseConnector(opts, (err, socket) => {
    if (!err) { socketsOpened++; connectMs.push(performance.now() - t); }
    cb(err, socket);
  });
};
const newAgent = (connections) => new Agent({ connections, connect: countingConnector });

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
console.log(`TCP RTT (median of 7 direct connects): ${f(rtt)}ms\n`);

async function one(dispatcher) {
  const t0 = performance.now();
  const r = { status: 0, id: null, total: -1, headers: -1, timing: {} };
  try {
    const resp = await uFetch(BASE + "/api/sandboxes", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: "{}",
      dispatcher,
    });
    r.headers = performance.now() - t0;
    const text = await resp.text();
    r.total = performance.now() - t0;
    r.body_read = r.total - r.headers;
    r.status = resp.status;
    r.timing = parseTiming(resp.headers.get("server-timing"));
    r.colo = (resp.headers.get("cf-ray") ?? "").split("-")[1] ?? "?";
    try { r.id = JSON.parse(text).sandboxID ?? null; } catch { r.err = text.slice(0, 80); }
  } catch (e) {
    r.total = performance.now() - t0; r.status = -1; r.err = String(e).slice(0, 80);
  }
  return r;
}

const all = [];
async function run(label, n, perRequestAgent) {
  socketsOpened = 0;
  connectMs = [];
  const shared = perRequestAgent ? null : newAgent(128);
  const agents = [];
  const mk = () => {
    if (!perRequestAgent) return shared;
    const a = newAgent(1);
    agents.push(a);
    return a;
  };
  const t0 = performance.now();
  const recs = await Promise.all(Array.from({ length: n }, () => one(mk())));
  const wall = performance.now() - t0;
  const ok = recs.filter((r) => r.status === 201 && r.id);
  for (const r of ok) {
    r.hdl = r.timing.hdl ?? 0;
    r.colo_admit = r.total - r.hdl - rtt - (r.body_read ?? 0);
  }
  const row = {
    label, n, perRequestAgent, ok: ok.length, wall,
    total: q(ok.map((r) => r.total), 0.5),
    hdl: q(ok.map((r) => r.hdl), 0.5),
    cell: q(ok.map((r) => r.timing.cell ?? 0), 0.5),
    colo_admit: q(ok.map((r) => r.colo_admit), 0.5),
    colo_admit_p95: q(ok.map((r) => r.colo_admit), 0.95),
    colo_admit_min: ok.length ? Math.min(...ok.map((r) => r.colo_admit)) : 0,
    sockets: socketsOpened,
    connect_p50: connectMs.length ? q(connectMs, 0.5) : 0,
    colos: [...new Set(ok.map((r) => r.colo))].join("/"),
  };
  all.push(row);
  console.log(`${label.padEnd(22)} n=${String(n).padStart(3)} ok=${String(row.ok).padStart(3)}  total ${f(row.total).padStart(7)}  hdl ${f(row.hdl).padStart(6)}  cell ${f(row.cell).padStart(6)}  colo_admit ${f(row.colo_admit).padStart(7)} (min ${f(row.colo_admit_min)} p95 ${f(row.colo_admit_p95)})  sockets=${row.sockets}@${f(row.connect_p50)}ms  colo=${row.colos}`);
  const bad = recs.filter((r) => r.status !== 201);
  if (bad.length) console.log(`   NON-201 ${bad.length}: ${[...new Set(bad.map((b) => `${b.status} ${(b.err ?? "").slice(0, 50)}`))].slice(0, 2).join(" | ")}`);
  // Give the boxes back before the next level so pool depth is not the variable.
  await Promise.all(ok.map((r) => uFetch(`${BASE}/api/sandboxes/${r.id}`, { method: "DELETE", headers: { "x-api-key": KEY } }).catch(() => {})));
  for (const a of agents) { try { await a.close(); } catch {} }
  if (shared) { try { await shared.close(); } catch {} }
  await new Promise((r) => setTimeout(r, Number(process.env.SETTLE_MS ?? 8000)));
  return row;
}

console.log("TEST A -- shared pool, concurrency swept:");
for (const n of LEVELS) await run(`shared N=${n}`, n, false);

console.log("\nTEST B -- one dedicated connection pool per request (client contention removed):");
for (const n of LEVELS) await run(`per-req N=${n}`, n, true);

console.log("\n=== VERDICT ===");
for (const n of LEVELS) {
  const a = all.find((r) => !r.perRequestAgent && r.n === n);
  const b = all.find((r) => r.perRequestAgent && r.n === n);
  if (!a || !b) continue;
  // A level where every create 503'd measured nothing. Printing its 0.0 beside
  // real rows would read as "admission was instant", which is the opposite of
  // the truth, so say VOID out loud instead.
  if (!a.ok || !b.ok) {
    console.log(`N=${String(n).padStart(3)}  VOID — ${!a.ok ? "shared" : "per-request"} level had 0 successful creates (pool drained / capacity gate)`);
    continue;
  }
  const d = a.colo_admit - b.colo_admit;
  console.log(`N=${String(n).padStart(3)}  shared colo_admit ${f(a.colo_admit).padStart(7)}ms   per-request ${f(b.colo_admit).padStart(7)}ms   delta ${f(d).padStart(7)}ms`);
}
console.log("\nIf per-request tracks shared, colo_admit is NOT client pool contention.");
console.log("If per-request collapses toward the sequential floor, it was ours all along.");

writeFileSync(OUT, all.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nwrote -> ${OUT}`);
