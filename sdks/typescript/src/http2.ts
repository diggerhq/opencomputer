// HTTP/2 multiplexing for the Node global fetch dispatcher.
//
// The SDK issues every request through the global `fetch`. On Node that's
// undici, which defaults to HTTP/1.1 — under a concurrent burst of creates it
// opens one TLS connection per request and serializes the rest behind its
// connection pool. Switching the global dispatcher to an HTTP/2-capable Agent
// multiplexes all of them over a single connection: an in-region burst-100 of
// create() measured median 363ms → 247ms and p95 972ms → 320ms (dispatch wall
// 9.4s → 0.3s). Sequential/keep-alive traffic is unaffected (already one reused
// connection); this is a concurrency win.
//
// `allowH2` negotiates per-origin via ALPN, so HTTP/1.1-only origins keep
// working unchanged — enabling it globally is safe. Browser-guarded (no global
// dispatcher there) and a graceful no-op if undici isn't present, so it never
// breaks a browser bundle or a stripped-down install. Opt out with
// OPENCOMPUTER_DISABLE_HTTP2=1.

let configured = false;

export function configureHttp2(): void {
  if (configured) return;
  configured = true;

  const isNode = typeof process !== "undefined" && !!process.versions?.node;
  if (!isNode) return;
  if (process.env?.OPENCOMPUTER_DISABLE_HTTP2) return;

  // Dynamic import so browser bundlers never pull undici into the graph, and a
  // missing undici (it's an optional dependency) degrades cleanly to HTTP/1.1.
  import("undici")
    .then(({ Agent, setGlobalDispatcher }) => {
      setGlobalDispatcher(new Agent({ allowH2: true }));
    })
    .catch(() => {
      /* undici unavailable — keep the default HTTP/1.1 dispatcher */
    });
}
