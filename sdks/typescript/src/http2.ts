// Connection pre-warming for the Node global fetch dispatcher.
//
// WHY: under a concurrent burst, the dominant cost of a sandbox create is not
// our API — it is opening ~100 TLS connections at once from one process.
// Measured against prod from an in-region client, 100 concurrent creates:
//
//     cold connections   min 686  median 716  p95 731   (flat: all pay the same)
//     warm connections   min 390  median 412  p95 436   (-304ms, -42%)
//
// The flatness is the tell — every request in the burst pays the same fixed
// cost, so it is admission/setup, not queueing behind our server. Corroborated
// end to end: a raw TLS test measured 100 concurrent handshakes at ~301ms
// (a single handshake is ~27ms), and the server-side phases sum to ~20ms
// (edge CPU 2ms, pool claim 10ms, control-plane finalize 1ms, worker claim 6ms)
// against a ~350ms client-observed create. The ~300ms gap is the handshakes.
//
// WHAT: hold a pool of already-established connections open so a later burst
// reuses them instead of negotiating TLS inside the latency it is measuring.
// Two parts, both required:
//   - keepAliveTimeout well above undici's 4s default, so idle connections are
//     not reaped between phases of a workload.
//   - a low-rate keepalive ping, so the connections stay live across long idle
//     gaps. (An earlier version warmed connections and then idled 60s; they had
//     all been closed by then and the burst was SLOWER than cold, because
//     undici tried the dead sockets first. The warm pool must be kept alive.)
//
// `allowH2` negotiates per-origin via ALPN, so HTTP/1.1-only origins keep
// working unchanged. Browser-guarded (no global dispatcher there). Opt out of
// HTTP/2 with OPENCOMPUTER_DISABLE_HTTP2=1, or of warming with
// OPENCOMPUTER_DISABLE_PREWARM=1 / OPENCOMPUTER_PREWARM_CONNECTIONS=0.

let configurePromise: Promise<void> | null = null;

// How many connections to hold open, and how often to keep them alive.
//
// 48. Swept against prod from an IAD runner (4 vCPU) at burst-100, TTI p50:
//
//   prewarm=100   23,990ms   opening 100 TLS connections while 100 creates are
//                            in flight starves the event loop; everything
//                            unblocks together at the end
//   prewarm=0        624ms   the opposite failure — undici marks an h2 session
//                            busy per in-flight POST, so 100 concurrent creates
//                            queue behind each other on one connection
//   prewarm=32       338ms
//   prewarm=48       301ms / 328ms (two runs)
//   prewarm=64       312ms
//
// The curve is flat between 32 and 64 — run-to-run variance on TTI p50 is ~27ms,
// so 48 vs 64 is not a real difference — and turns back up past that because
// establishing the pool starts costing more than it saves (424ms to open 64
// versus 153ms for 48, paid inside the measured window). 48 sits at the bottom
// with margin on both sides.
//
// Note the 100 figure is not a typo: this was shipped as the default on the
// theory that a smaller pool merely warms fewer connections. It is worth 34x in
// the exact shape it was written for.
const DEFAULT_PREWARM = 48;
const KEEPALIVE_INTERVAL_MS = 30_000;
// Above undici's 4s default so an idle connection survives between phases of a
// workload; still far below any sane server-side idle close.
const KEEP_ALIVE_TIMEOUT_MS = 600_000;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// configureHttp2 installs the global dispatcher on Node and RESOLVES ONLY ONCE
// IT IS INSTALLED. The entry point (index.ts) awaits it at module load, so by
// the time an importer can issue a request the dispatcher is already swapped —
// otherwise the first burst races the async `import("undici")` and leaks onto
// the default dispatcher (the exact failure that made this a silent no-op).
// Memoized + never rejects, so importing the SDK can safely `await` it.
export function configureHttp2(): Promise<void> {
  if (configurePromise) return configurePromise;
  configurePromise = (async () => {
    const isNode = typeof process !== "undefined" && !!process.versions?.node;
    if (isNode !== true) return; // browser: no global dispatcher to set
    if (process.env?.OPENCOMPUTER_DISABLE_HTTP2) return;
    try {
      // Dynamic import so browser bundlers never pull undici into the graph.
      // undici is a hard dependency on Node (see package.json) so this resolves;
      // the catch keeps a stripped-down/browser install on the default agent.
      const { Agent, setGlobalDispatcher } = await import("undici");
      setGlobalDispatcher(
        new Agent({
          allowH2: true,
          keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
          keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT_MS,
        }),
      );
    } catch {
      /* undici unavailable — keep the default dispatcher */
    }
  })();
  return configurePromise;
}

let warmPromise: Promise<void> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

// prewarmConnections opens `count` connections to `apiUrl` and keeps them alive,
// so a later burst reuses them instead of paying ~300ms of concurrent TLS
// handshakes inside its own latency. Idempotent, never rejects, and safe to call
// on a hot path: callers may fire-and-forget it.
//
// The keepalive timer is unref'd — a warm pool must never be the reason a
// process stays alive.
export function prewarmConnections(apiUrl: string, count?: number): Promise<void> {
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    const isNode = typeof process !== "undefined" && !!process.versions?.node;
    if (isNode !== true) return;
    if (process.env?.OPENCOMPUTER_DISABLE_PREWARM) return;
    const n = count ?? intFromEnv("OPENCOMPUTER_PREWARM_CONNECTIONS", DEFAULT_PREWARM);
    if (n <= 0) return;
    await configureHttp2(); // warm onto the configured dispatcher, not the default

    // The warm MUST use the same method class as the traffic it is warming for.
    // undici refuses to multiplex non-idempotent requests over one HTTP/2
    // session (client-h2.js marks the client busy while any request is in
    // flight), so N concurrent POSTs need N separate connections, while N
    // concurrent GETs happily share ONE h2 session. Warming with GET therefore
    // warms a single connection and leaves a POST burst to pay ~100 handshakes
    // anyway — which is exactly why the first version of this measured as a
    // no-op end to end. POST to a path that costs the server nothing (405/404
    // is fine — we only want the socket).
    const base = apiUrl.replace(/\/+$/, "");
    const ping = (): Promise<unknown> =>
      fetch(`${base}/health`, { method: "POST" })
        .then((r) => r.arrayBuffer())
        .catch(() => undefined);

    // Fire them together: a connection is only created while another is still
    // busy, so the pings must overlap — sequential pings would reuse one socket.
    await Promise.all(Array.from({ length: n }, ping));

    if (keepAliveTimer === null) {
      keepAliveTimer = setInterval(() => {
        // Same reasoning as the initial warm: these must be concurrent, or the
        // pool collapses back to one connection between bursts.
        void Promise.all(Array.from({ length: n }, ping));
      }, KEEPALIVE_INTERVAL_MS);
      keepAliveTimer.unref?.();
    }
  })();
  return warmPromise;
}
