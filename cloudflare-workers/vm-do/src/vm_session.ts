import { decodeResult, encodeExec, type ExecResult } from "./protocol";

// VmSession — one Durable Object per sandbox, holding a persistent, hibernatable
// WebSocket that the QEMU worker HOST dials into (host-dialed, not guest-dialed).
// Exec requests arrive over HTTP (from the edge's exec route) and are relayed to
// the host as a protobuf frame; the reply is correlated by requestId. This
// re-homes the internal/wsgateway broker concept back into an edge DO.
//
// Auth is enforced at the edge /internal/vms/:id/connect route (a per-sandbox
// HMAC over SESSION_JWT_SECRET) before the upgrade reaches this DO, so the DO
// itself is unauthenticated glue.
// Written in the plain-class DO style (like shared/credit_account.ts) so it needs
// no `cloudflare:workers` import and loads under the plain-node vitest setup.

interface PendingCommand {
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RunBody {
  cmd?: string;
  args?: string[];
  cwd?: string;
  envs?: Record<string, string>;
  timeout?: number;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

// commandFrom flattens the SDK's {cmd,args} into a single shell string for the
// agent's one-shot Exec. The common `sh -c "<script>"` shape is passed through
// verbatim; anything else is shell-quoted.
function commandFrom(body: RunBody): string {
  if (body.cmd === "sh" && body.args?.[0] === "-c" && typeof body.args[1] === "string") return body.args[1];
  if (!body.cmd) throw new Error("cmd is required");
  return [body.cmd, ...(body.args ?? [])].map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
}

export class VmSession {
  state: DurableObjectState;

  private readonly pending = new Map<number, PendingCommand>();
  private nextRequestId = Math.floor(Math.random() * 0x7fffffff) + 1;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
    // Rebind hibernation-restored sockets' message/close handlers to this
    // instance (the runtime re-creates the DO on wake with the sockets intact).
    // acceptWebSocket already tagged them "vm"; nothing else to restore.
  }

  // The live host WebSocket (hibernatable, tagged "vm"), if connected.
  private connectedSocket(): WebSocket | undefined {
    return this.state.getWebSockets("vm").find((socket) => socket.readyState === WebSocket.OPEN);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.acceptHostConnection();
    if (url.pathname === "/status") return json({ connected: this.connectedSocket() !== undefined });
    if (url.pathname === "/location") {
      const trace = await fetch("https://www.cloudflare.com/cdn-cgi/trace").then((r) => r.text());
      const fields = Object.fromEntries(trace.trim().split("\n").map((l) => l.split("=", 2)));
      return json({ colo: fields.colo ?? null, loc: fields.loc ?? null });
    }
    if (url.pathname === "/exec" && request.method === "POST") {
      let body: RunBody;
      try {
        body = (await request.json()) as RunBody;
      } catch {
        return json({ error: "invalid body" }, { status: 400 });
      }
      // Diagnostic: socket census at exec time — sid comes from the edge as a
      // query param (idFromName is one-way, the DO doesn't know its own name).
      const socks = this.state.getWebSockets("vm");
      console.log(
        `exec sid=${url.searchParams.get("sid") ?? "?"} sockets=${socks.length} states=[${socks.map((s) => s.readyState).join(",")}]`,
      );
      // Entry grace: under a burst, ~100 hibernated VmSessions wake at once and
      // a few serve their first exec before the restored socket is visible —
      // host-side evidence shows the TCP connection stayed up the whole time.
      // Waiting briefly turns that wake-race into a slightly slower DO exec
      // instead of an instant 409 → tunnel (~1s). A genuinely dead channel
      // still falls back, just ~400ms later.
      if (!this.connectedSocket()) {
        for (let waited = 0; waited < 400 && !this.connectedSocket(); waited += 50) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      // connected:false lets the edge fall back to the tunnel path (no flag).
      if (!this.connectedSocket()) return json({ connected: false, error: "vm not connected" }, { status: 409 });
      try {
        const result = await this.run(
          commandFrom(body),
          body.cwd ?? "",
          body.envs ?? {},
          Math.max(1, body.timeout ?? 60) * 1000,
        );
        // x-agent-ms = host-side manager.Exec duration from the result frame —
        // lets the edge's Server-Timing split DO-transit from agent time.
        return json(
          { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
          { headers: { "x-agent-ms": String(result.durationMs) } },
        );
      } catch (e) {
        // Channel dropped mid-exec, or command errored on the agent side — 409
        // so the edge can retry via the tunnel instead of surfacing a 500.
        return json({ connected: false, error: String((e as Error)?.message ?? e) }, { status: 409 });
      }
    }
    return new Response("not found", { status: 404 });
  }

  // One-shot colo self-identification (diagnostics): DO placement is sticky at
  // first-touch, and a DO sitting cross-colo from the edge that calls it adds
  // per-hop RTT that Server-Timing can't attribute on its own.
  private coloLogged = false;

  private logColoOnce(kind: string): void {
    if (this.coloLogged) return;
    this.coloLogged = true;
    void fetch("https://www.cloudflare.com/cdn-cgi/trace")
      .then(async (r) => {
        const colo = ((await r.text()).match(/^colo=(\w+)/m) ?? [])[1] ?? "?";
        console.log(`vmsession colo=${colo} (${kind})`);
      })
      .catch(() => {});
  }

  private acceptHostConnection(): Response {
    this.logColoOnce("connect");
    console.log(`connect: replacing ${this.state.getWebSockets("vm").length} existing socket(s)`);
    // Only one host socket per box; a redial replaces the old one.
    for (const socket of this.state.getWebSockets("vm")) socket.close(1012, "replaced");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, ["vm"]); // hibernatable — survives DO eviction
    server.serializeAttachment({ role: "vm", connectedAt: Date.now() });
    return new Response(null, {
      status: 101,
      headers: { "sec-websocket-protocol": "oc-protobuf-v1" },
      webSocket: client,
    });
  }

  private async run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<ExecResult> {
    // Reconnect grace: a dropped socket takes the host one backoff cycle to
    // redial. Wait briefly so a redial-in-flight becomes a slightly slower exec
    // rather than a hard failure.
    let socket = this.connectedSocket();
    for (let waited = 0; !socket && waited < 3_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket = this.connectedSocket();
    }
    if (!socket) throw new Error("vm not connected");
    const requestId = this.nextRequestId++ >>> 0 || 1;
    const result = new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`command timed out after ${timeoutMs}ms`));
      }, timeoutMs + 1_000);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    socket.send(encodeExec({ requestId, command, cwd, timeoutMs, env }));
    return result;
  }

  webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): void {
    if (!(message instanceof ArrayBuffer)) return;
    let result: ExecResult;
    try {
      result = decodeResult(message);
    } catch (error) {
      console.error("invalid VM frame", error);
      return;
    }
    const pending = this.pending.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(result.requestId);
    if (result.error) pending.reject(new Error(result.error));
    else pending.resolve(result);
  }

  webSocketClose(_socket: WebSocket, code: number, reason: string): void {
    const error = new Error(`vm disconnected (${code}: ${reason})`);
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  webSocketError(_socket: WebSocket, error: unknown): void {
    console.error("vm websocket error", error);
  }
}
