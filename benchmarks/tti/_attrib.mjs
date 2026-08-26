// Where does every millisecond of a burst create actually go?
//
// Four separate attempts have now failed to attribute the ~420ms that appears
// on a burst create and not on a sequential one: handshakes (batching 26:1
// changed nothing), CP compute (42us), edge CPU (p50 1ms), and distance (a
// constant cannot produce a 4x delta on the same path). Every one of those was
// argued from marks reported by the component under test — and a component
// cannot report time it spent waiting to be allowed to run.
//
// So this measures differently. Three clocks, never compared to each other:
//
//   T1..T4   client send -> client receive        (this process's clock)
//   hdl      edge handler entry -> exit           (the edge's clock)
//   cptotal  CP handler entry -> exit             (the CP's clock, from journald)
//
// Every quantity is a difference of two readings taken by the SAME machine, so
// clock skew cancels instead of leaking into the answer — no NTP assumption, no
// trust in anyone's absolute timestamps. The number we actually want is the one
// nobody reports:
//
//   unaccounted = (T4 - T1) - hdl
//
// which is client<->edge wire plus any time the request sat queued before the
// Worker began executing. If that term is small, the burst penalty is inside
// our handler and the marks will find it. If it is large, the penalty is
// upstream of our code entirely and no amount of handler instrumentation will
// ever see it.
//
// Join key is sandboxID: the CP already logs `createtrace sb-xxxx total=NNus`
// and the client gets sandboxID back in the response, so the two ends are
// linkable with no correlation-ID plumbing on the hot path.
import { writeFileSync } from "node:fs";

const URL_BASE = process.env.OPENCOMPUTER_API_URL ?? "https://app2.opensandbox.ai";
const KEY = process.env.OPENCOMPUTER_API_KEY;
const N = Number(process.env.N ?? 100);
const MODE = process.env.MODE ?? "burst";
const OUT = process.env.OUT ?? "/tmp/attrib.ndjson";

if (!KEY) {
  console.error("set OPENCOMPUTER_API_KEY");
  process.exit(1);
}

/** Parse a Server-Timing header into {mark: ms}. */
function parseTiming(h) {
  const out = {};
  for (const part of (h ?? "").split(",")) {
    const m = part.trim().match(/^([a-z0-9_]+);dur=([0-9.]+)/i);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

async function one(i) {
  // T1/T4 both come from performance.now() in THIS process. Their difference is
  // the only client-side quantity used anywhere, so the client's absolute clock
  // (and its offset from every other machine) is irrelevant by construction.
  const t1 = performance.now();
  let rec = { i, t1, total: -1, status: 0, id: null, timing: {} };
  try {
    const r = await fetch(URL_BASE + "/api/sandboxes", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: "{}",
    });
    const text = await r.text();
    rec.total = performance.now() - t1;
    rec.status = r.status;
    rec.timing = parseTiming(r.headers.get("server-timing"));
    rec.colo = (r.headers.get("cf-ray") ?? "").split("-")[1] ?? "?";
    try {
      rec.id = JSON.parse(text).sandboxID ?? null;
    } catch {
      rec.body = text.slice(0, 120);
    }
  } catch (e) {
    rec.total = performance.now() - t1;
    rec.status = -1;
    rec.body = String(e).slice(0, 120);
  }
  return rec;
}

const t0 = performance.now();
let recs;
if (MODE === "seq") {
  recs = [];
  for (let i = 0; i < N; i++) recs.push(await one(i));
} else {
  recs = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
}
const wall = performance.now() - t0;

const ok = recs.filter((r) => r.status === 201 && r.id);
const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : -1;
};
const f = (n) => (n < 0 ? "-" : n.toFixed(0));
const stat = (name, v) =>
  `${name.padEnd(14)} n=${String(v.length).padStart(4)}  p50 ${f(q(v, 0.5)).padStart(6)}  p95 ${f(q(v, 0.95)).padStart(6)}  max ${f(Math.max(...v, -1)).padStart(6)}`;

console.log(`\n=== attribution ${MODE} N=${N} — ${ok.length}/${N} ok, wall ${f(wall)}ms ===\n`);
console.log("  " + stat("total (T4-T1)", ok.map((r) => r.total)));
console.log("  " + stat("hdl (edge)", ok.map((r) => r.timing.hdl ?? -1).filter((x) => x >= 0)));
console.log("  " + stat("cell (edge)", ok.map((r) => r.timing.cell ?? -1).filter((x) => x >= 0)));

// THE number: what no component on the path reports about itself.
const unacc = ok.filter((r) => r.timing.hdl !== undefined).map((r) => r.total - r.timing.hdl);
console.log("  " + stat("UNACCOUNTED", unacc));
console.log(
  `\n  unaccounted = (T4-T1) - hdl  — client<->edge wire + time queued before the\n` +
    `  Worker started running. No mark inside the handler can see this.\n`,
);

const colos = {};
for (const r of ok) colos[r.colo] = (colos[r.colo] ?? 0) + 1;
console.log("  colos:", Object.entries(colos).map(([k, v]) => `${k}=${v}`).join(" "));

const bad = recs.filter((r) => r.status !== 201);
if (bad.length) {
  const kinds = {};
  for (const b of bad) kinds[`${b.status} ${(b.body ?? "").slice(0, 60)}`] = (kinds[`${b.status} ${(b.body ?? "").slice(0, 60)}`] ?? 0) + 1;
  console.log("\n  NON-201:", Object.entries(kinds).map(([k, v]) => `${v}x ${k}`).join(" | "));
}

writeFileSync(OUT, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nwrote ${recs.length} records -> ${OUT}`);
console.log(`join with the CP: grep createtrace for each sandboxID to add cptotal.`);

// Clean up: these are real sandboxes.
await Promise.all(
  ok.map((r) =>
    fetch(`${URL_BASE}/api/sandboxes/${r.id}`, { method: "DELETE", headers: { "x-api-key": KEY } }).catch(() => {}),
  ),
);
console.log(`destroyed ${ok.length}`);
