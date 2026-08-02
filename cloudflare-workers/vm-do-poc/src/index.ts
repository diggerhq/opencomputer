import { DurableObject } from "cloudflare:workers";
import { decodeResult, encodeExec, type ExecResult } from "./protocol";

type WorkerEnv = Env & {
  BENCH_API_TOKEN: string;
  VM_CONNECT_SECRET: string;
};

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

async function tokenMatches(provided: string | null, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

function socketSecret(request: Request): string | null {
  const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()) ?? [];
  return protocols[0] === "oc-protobuf-v1" ? protocols[1] ?? null : null;
}

function commandFrom(body: RunBody): string {
  if (body.cmd === "sh" && body.args?.[0] === "-c" && typeof body.args[1] === "string") return body.args[1];
  if (!body.cmd) throw new Error("cmd is required");
  return [body.cmd, ...(body.args ?? [])].map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
}

export class VmSession extends DurableObject<WorkerEnv> {
  private readonly pending = new Map<number, PendingCommand>();
  private nextRequestId = Math.floor(Math.random() * 0x7fffffff) + 1;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
  }

  private connectedSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets("vm").find((socket) => socket.readyState === WebSocket.OPEN);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.acceptVmConnection();
    if (url.pathname === "/lease") {
      return json({ connected: this.connectedSocket() !== undefined });
    }
    if (url.pathname === "/exec" && request.method === "POST") {
      const startedAt = performance.now();
      const body = (await request.json()) as RunBody;
      const result = await this.run(commandFrom(body), body.cwd ?? "", body.envs ?? {}, Math.max(1, body.timeout ?? 60) * 1000);
      return json({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        pocTiming: {
          durableObjectMs: performance.now() - startedAt,
          vmProcessMs: result.durationMs,
        },
      });
    }
    return new Response("not found", { status: 404 });
  }

  private acceptVmConnection(): Response {
    for (const socket of this.ctx.getWebSockets("vm")) socket.close(1012, "replaced");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["vm"]);
    server.serializeAttachment({ role: "vm", connectedAt: Date.now() });
    return new Response(null, {
      status: 101,
      headers: { "sec-websocket-protocol": "oc-protobuf-v1" },
      webSocket: client,
    });
  }

  private async run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<ExecResult> {
    const socket = this.connectedSocket();
    if (!socket) throw new Error("warm VM is not connected");
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
    const error = new Error(`VM disconnected (${code}: ${reason})`);
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  webSocketError(_socket: WebSocket, error: unknown): void {
    console.error("VM WebSocket error", error);
  }
}

function stubFor(env: WorkerEnv, sandboxId: string): DurableObjectStub {
  return env.VM_SESSIONS.get(env.VM_SESSIONS.idFromName(sandboxId), { locationHint: "enam" });
}

async function requireApiAuth(request: Request, env: WorkerEnv): Promise<Response | null> {
  return (await tokenMatches(request.headers.get("x-api-key"), env.BENCH_API_TOKEN))
    ? null
    : json({ error: "unauthorized" }, { status: 401 });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, vmId: env.POC_VM_ID });

    const connectMatch = url.pathname.match(/^\/internal\/vms\/([^/]+)\/connect$/);
    if (connectMatch && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (connectMatch[1] !== env.POC_VM_ID || !(await tokenMatches(socketSecret(request), env.VM_CONNECT_SECRET))) {
        return new Response("unauthorized", { status: 401 });
      }
      return stubFor(env, connectMatch[1]).fetch(new Request("https://do/connect", request));
    }

    const bootstrapMatch = url.pathname.match(/^\/internal\/vms\/([^/]+)\/bootstrap$/);
    if (bootstrapMatch && request.method === "POST") {
      const denied = await requireApiAuth(request, env);
      if (denied) return denied;
      if (bootstrapMatch[1] !== env.POC_VM_ID) return json({ error: "not found" }, { status: 404 });
      const startedAt = performance.now();
      const response = await stubFor(env, bootstrapMatch[1]).fetch("https://do/lease");
      const lease = (await response.json()) as { connected: boolean };
      return json({
        ok: true,
        connected: lease.connected,
        frontendColo: request.cf?.colo ?? null,
        bootstrapMs: performance.now() - startedAt,
      });
    }

    const denied = await requireApiAuth(request, env);
    if (denied) return denied;

    if (url.pathname === "/api/sandboxes" && request.method === "POST") {
      const startedAt = performance.now();
      return json({
        sandboxID: env.POC_VM_ID,
        status: "running",
        templateID: "base",
        connectURL: `${url.origin}/api/sandboxes/${env.POC_VM_ID}`,
        token: env.BENCH_API_TOKEN,
        pocTiming: { createEdgeMs: performance.now() - startedAt },
      });
    }

    const sandboxMatch = url.pathname.match(/^\/api\/sandboxes\/([^/]+)$/);
    if (sandboxMatch && sandboxMatch[1] === env.POC_VM_ID) {
      if (request.method === "GET") return json({ sandboxID: env.POC_VM_ID, status: "running" });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
    }

    const execMatch = url.pathname.match(/^\/api\/sandboxes\/([^/]+)\/exec\/run-async$/);
    if (execMatch && execMatch[1] === env.POC_VM_ID && request.method === "POST") {
      const response = await stubFor(env, execMatch[1]).fetch("https://do/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: request.body,
      });
      return new Response(response.body, response);
    }

    return json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
