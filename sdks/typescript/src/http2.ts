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
// dispatcher there). Opt out with OPENCOMPUTER_DISABLE_HTTP2=1.

let configurePromise: Promise<void> | null = null;

// configureHttp2 installs the HTTP/2-capable global dispatcher on Node and
// RESOLVES ONLY ONCE IT IS INSTALLED. The entry point (index.ts) awaits it at
// module load, so by the time an importer can issue a request the dispatcher is
// already swapped — otherwise the first burst of requests races the async
// `import("undici")` and leaks onto HTTP/1.1 (the exact failure that made this a
// silent no-op in practice). Memoized + never rejects, so importing the SDK can
// safely `await` it without a try/catch and without repeating the work.
export function configureHttp2(): Promise<void> {
  if (configurePromise) return configurePromise;
  configurePromise = (async () => {
    const isNode = typeof process !== "undefined" && !!process.versions?.node;
    if (!isNode) return; // browser: no global dispatcher to set
    if (process.env?.OPENCOMPUTER_DISABLE_HTTP2) return;
    try {
      // Dynamic import so browser bundlers never pull undici into the graph.
      // undici is a hard dependency on Node (see package.json) so this resolves;
      // the catch keeps a stripped-down/browser install degrading to HTTP/1.1.
      const { Agent, setGlobalDispatcher } = await import("undici");
      setGlobalDispatcher(new Agent({ allowH2: true }));
    } catch {
      /* undici unavailable — keep the default HTTP/1.1 dispatcher */
    }
  })();
  return configurePromise;
}
