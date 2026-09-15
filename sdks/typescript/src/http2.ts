// The sandbox client's transport: an HTTP/2 connection pool it owns and
// passes to every request it makes, plus the pre-warming of that pool.
//
// Client-owned, not global. The pool is an undici Agent handed to fetch as the
// per-request `dispatcher`; the process's global dispatcher is never touched,
// so an application's own fetch traffic, and any other library's, keeps its
// own settings. Nothing here runs at import: the Agent is created on the
// first request the sandbox client makes, and the pool is warmed on the
// first `Sandbox.create` (or on an explicit `prewarmConnections` call from a
// program that wants the cost paid before its timing loop).
//
// WHY a warm pool: under a concurrent burst, the dominant cost of a sandbox
// create is not our API but opening ~100 TLS connections at once from one
// process. Measured against prod from an in-region client, 100 concurrent
// creates:
//
//     cold connections   min 686  median 716  p95 731   (flat: all pay the same)
//     warm connections   min 390  median 412  p95 436   (-304ms, -42%)
//
// The flatness is the tell: every request in the burst pays the same fixed
// cost, so it is admission/setup, not queueing behind our server. A raw TLS
// test measured 100 concurrent handshakes at ~301ms (a single handshake is
// ~27ms), and the server-side phases sum to ~20ms against a ~350ms
// client-observed create. The ~300ms gap is the handshakes.
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
// working unchanged. Outside Node (browsers, Workers) there is no undici and
// requests go to the global fetch untouched. Opt out of HTTP/2 with
// OPENCOMPUTER_DISABLE_HTTP2=1, or of warming with
// OPENCOMPUTER_DISABLE_PREWARM=1 / OPENCOMPUTER_PREWARM_CONNECTIONS=0.

// How many connections to hold open, and how often to keep them alive.
//
// 48. Swept against prod from an IAD runner (4 vCPU) at burst-100, TTI p50:
//
//   prewarm=100   23,990ms   opening 100 TLS connections while 100 creates are
//                            in flight starves the event loop; everything
//                            unblocks together at the end
//   prewarm=0        624ms   the opposite failure: undici marks an h2 session
//                            busy per in-flight POST, so 100 concurrent creates
//                            queue behind each other on one connection
//   prewarm=32       338ms
//   prewarm=48       301ms / 328ms (two runs)
//   prewarm=64       312ms
//
// The curve is flat between 32 and 64 (run-to-run variance on TTI p50 is
// ~27ms) and turns back up past that because establishing the pool starts
// costing more than it saves (424ms to open 64 versus 153ms for 48, paid
// inside the measured window). 48 sits at the bottom with margin on both sides.
const DEFAULT_PREWARM = 48;
const KEEPALIVE_INTERVAL_MS = 30_000;
// Above undici's 4s default so an idle connection survives between phases of a
// workload; still far below any sane server-side idle close.
const KEEP_ALIVE_TIMEOUT_MS = 600_000;

const DEFAULT_API_URL = "https://app.opencomputer.dev";

/** The non-standard init undici's fetch reads: which pool serves the request. */
type DispatchedInit = RequestInit & { dispatcher?: unknown };

const isNode = (): boolean => typeof process !== "undefined" && !!process.versions?.node;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

let dispatcherPromise: Promise<unknown> | null = null;

// The pool, created once on first use. Resolves to `undefined` outside Node,
// when HTTP/2 is disabled, or when undici cannot be loaded; requests then use
// the global fetch as it is. Never rejects.
function dispatcher(): Promise<unknown> {
  if (dispatcherPromise) return dispatcherPromise;
  dispatcherPromise = (async () => {
    if (!isNode()) return undefined;
    if (process.env?.OPENCOMPUTER_DISABLE_HTTP2) return undefined;
    try {
      // Dynamic import so browser bundlers never pull undici into the graph.
      // undici is a hard dependency on Node (see package.json) so this resolves;
      // the catch keeps a stripped-down install on the default transport.
      const { Agent } = await import("undici");
      return new Agent({
        allowH2: true,
        keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
        keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT_MS,
      });
    } catch {
      return undefined;
    }
  })();
  return dispatcherPromise;
}

/**
 * fetch over the sandbox client's own connection pool. The global fetch is
 * called (so a test that replaces it sees every request) with the pool as the
 * per-request dispatcher; the global dispatcher is left alone.
 */
export async function apiFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const pool = await dispatcher();
  if (!pool) return fetch(input, init);
  const dispatched: DispatchedInit = { ...init, dispatcher: pool };
  return fetch(input, dispatched);
}

let warmPromise: Promise<void> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Opens `count` connections to the API and keeps them alive, so a later burst
 * reuses them instead of paying ~300ms of concurrent TLS handshakes inside
 * its own latency. Idempotent, never rejects, and safe to call on a hot path:
 * `Sandbox.create` fires it on first use and callers may fire-and-forget it
 * earlier, before a timing loop.
 *
 * `apiUrl` defaults to `OPENCOMPUTER_API_URL` or `https://app.opencomputer.dev`.
 * The keepalive timer is unref'd: a warm pool is never the reason a process
 * stays alive.
 */
export function prewarmConnections(apiUrl?: string, count?: number): Promise<void> {
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    if (!isNode()) return;
    if (process.env?.OPENCOMPUTER_DISABLE_PREWARM) return;
    const n = count ?? intFromEnv("OPENCOMPUTER_PREWARM_CONNECTIONS", DEFAULT_PREWARM);
    if (n <= 0) return;
    const origin = (apiUrl ?? process.env?.OPENCOMPUTER_API_URL ?? DEFAULT_API_URL)
      .replace(/\/+$/, "")
      .replace(/\/api$/, "");

    // The warm MUST use the same method class as the traffic it is warming for.
    // undici refuses to multiplex non-idempotent requests over one HTTP/2
    // session (client-h2.js marks the client busy while any request is in
    // flight), so N concurrent POSTs need N separate connections, while N
    // concurrent GETs happily share ONE h2 session. Warming with GET therefore
    // warms a single connection and leaves a POST burst to pay ~100 handshakes
    // anyway. POST to a path that costs the server nothing (405/404 is fine;
    // only the socket matters).
    const ping = (): Promise<unknown> =>
      apiFetch(`${origin}/health`, { method: "POST" })
        .then((r) => r.arrayBuffer())
        .catch(() => undefined);

    // Fire them together: a connection is only created while another is still
    // busy, so the pings must overlap; sequential pings would reuse one socket.
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
