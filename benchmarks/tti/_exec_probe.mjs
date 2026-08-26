// Decompose exec's fixed ~107ms leg.
//
// exec is load-INVARIANT (min 123.2ms sequential vs 124.5ms at burst-100), so
// contention is already ruled out — this is a structural floor. There are only
// three places it can be, and this probe separates them by construction rather
// than by inference:
//
//   1. connection setup   CP->box TCP+TLS, paid per exec if the keep-alive pool
//                         isn't holding the connection (MaxIdleConnsPerHost: 4,
//                         IdleConnTimeout 90s in internal/awsvmlite/lite.go).
//   2. wire               CP (westus2) <-> box (us-east-1), one round trip.
//   3. guest              the command actually running inside the box.
//
// THE DISCRIMINATOR: run the SAME command N times against the SAME box, back to
// back. Exec #1 pays for whatever setup is needed; execs #2..N reuse it. If #1
// is much slower than the rest, the floor is setup and it is FIXABLE. If they
// are all equal, the floor is wire+guest and no amount of pooling touches it.
//
// The CP already logs the other half of the split for us --
// `awsvmlite: exec <id> rt=<ms> cmd=<ms>` at lite.go:549 -- where rt is the
// CP->box round trip and cmd is what the guest spent. Client total minus rt is
// then the client->edge->CP leg. Pull those lines after this run and every
// millisecond has a home.
import { Sandbox } from "@opencomputer/sdk";

const REPEATS = Number(process.env.REPEATS ?? 10);
const BOXES = Number(process.env.BOXES ?? 3);
const CMD = process.env.CMD ?? "node -v";

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const f = (n) => n.toFixed(1);

const rows = [];
for (let b = 0; b < BOXES; b++) {
  const tc = performance.now();
  const sb = await Sandbox.create({});
  const createMs = performance.now() - tc;
  const seq = [];
  for (let i = 0; i < REPEATS; i++) {
    const t = performance.now();
    let err = null;
    try { await sb.exec.run(CMD); } catch (e) { err = String(e).slice(0, 60); }
    seq.push({ i, ms: performance.now() - t, err });
  }
  rows.push({ box: b, id: sb.sandboxId ?? sb.id ?? "?", createMs, seq });
  console.log(`box ${b} (${sb.sandboxId ?? sb.id}) create ${f(createMs)}ms  execs: ${seq.map((s) => f(s.ms)).join(" ")}`);
  try { await sb.destroy(); } catch {}
}

console.log(`\n=== EXEC FLOOR: same box, ${REPEATS} back-to-back execs, ${BOXES} boxes ===`);
const byIdx = [];
for (let i = 0; i < REPEATS; i++) byIdx.push(rows.map((r) => r.seq[i]?.ms).filter((x) => x != null));
console.log("exec#   p50       min      (n)");
byIdx.forEach((v, i) => {
  if (!v.length) return;
  console.log(`  ${String(i + 1).padStart(2)}   ${f(q(v, 0.5)).padStart(7)}ms ${f(Math.min(...v)).padStart(8)}ms   ${v.length}`);
});

const first = byIdx[0] ?? [];
const rest = byIdx.slice(1).flat();
if (first.length && rest.length) {
  const d = q(first, 0.5) - q(rest, 0.5);
  console.log(`\nfirst-exec premium: ${f(d)}ms  (first p50 ${f(q(first, 0.5))} vs repeat p50 ${f(q(rest, 0.5))})`);
  console.log(d > 25
    ? "  => setup-bound. The connection is NOT being reused across the first exec."
    : "  => NOT setup. The floor is wire + guest; connection pooling cannot move it.");
}
const ids = rows.map((r) => r.id).join(" ");
console.log(`\nsandbox ids for journal join: ${ids}`);
