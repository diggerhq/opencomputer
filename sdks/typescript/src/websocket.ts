// websocket.ts — opening a WebSocket without tripping over our own HTTP/2 agent.
//
// The REST surface runs on an undici Agent with `allowH2: true` (http2.ts):
// h2 multiplexes a burst of creates down one connection. A WebSocket must not
// use that agent: it would negotiate h2 via ALPN and then try to upgrade, and
// a WebSocket over h2 needs RFC 8441 extended CONNECT, which the server's
// WebSocket library does not implement (nor do most), so the upgrade simply
// fails.
//
// Measured against dev, same URL, back to back:
//
//   default dispatcher (no allowH2): OPEN
//   allowH2:true dispatcher        : ERROR
//
// So WebSockets get their own dispatcher with h2 off, passed per connection.
// The REST path keeps h2 and its prewarmed pool; only the upgrade is forced
// down HTTP/1.1, which is what an upgrade requires anyway. Neither agent is
// ever installed as the process's global dispatcher.

let wsDispatcher: unknown | null = null;
let wsCtor: typeof WebSocket | null = null;

async function nodeWebSocket(): Promise<typeof WebSocket | null> {
  const isNode = typeof process !== "undefined" && !!process.versions?.node;
  if (!isNode) return null; // browsers speak WebSocket natively; nothing to fix
  try {
    const undici = await import("undici");
    if (!wsDispatcher) {
      // allowH2 omitted (defaults false) rather than set — an h1-only agent is
      // the point, and spelling it out invites someone to "align" it with the
      // global one later.
      wsDispatcher = new undici.Agent({ keepAliveTimeout: 60_000 });
    }
    return undici.WebSocket as unknown as typeof WebSocket;
  } catch {
    return null; // stripped-down install — fall back to whatever global exists
  }
}

// openWebSocket resolves once the socket is OPEN, and rejects if it errors or
// closes first.
//
// Resolving early is its own bug: a CONNECTING socket throws "Sent before
// connected" on the first send, and creating a PTY then immediately typing
// into it is the normal way to use one.
export async function openWebSocket(url: string): Promise<WebSocket> {
  if (!wsCtor) wsCtor = await nodeWebSocket();
  const Ctor = wsCtor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Ctor) throw new Error("no WebSocket implementation available in this environment");

  const ws = wsDispatcher
    ? new (Ctor as unknown as new (u: string, o: unknown) => WebSocket)(url, { dispatcher: wsDispatcher })
    : new Ctor(url);
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve();
    };
    ws.onerror = () => {
      if (!opened) reject(new Error(`WebSocket connection failed: ${url}`));
    };
    ws.onclose = () => {
      if (!opened) reject(new Error(`WebSocket closed before opening: ${url}`));
    };
  });
  // Handlers are cleared so a caller's own onerror/onclose are not shadowed by
  // the ones used to await the open.
  ws.onopen = null;
  ws.onerror = null;
  ws.onclose = null;
  return ws;
}
