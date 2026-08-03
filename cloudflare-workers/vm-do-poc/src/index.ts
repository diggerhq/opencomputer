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
    if (url.pathname === "/location") {
      const trace = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { cache: "no-store" }).then((response) => response.text());
      const fields = Object.fromEntries(trace.trim().split("\n").map((line) => line.split("=", 2)));
      return json({ colo: fields.colo ?? null, loc: fields.loc ?? null });
    }
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
    // Reconnect grace: a dropped socket takes the agent one backoff cycle to
    // redial (250ms-10s). Waiting briefly here turns that window from a hard
    // 500 into a slightly slower exec.
    let socket = this.connectedSocket();
    for (let waited = 0; !socket && waited < 3_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket = this.connectedSocket();
    }
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
  // Placement hint is config, not code: the DO must sit in the same region as
  // the VM it fronts (the persistent WS is the long-lived hop; the Worker→DO
  // leg rides Cloudflare's backbone from any ingress colo). enam matches the
  // original IAD/eastus2 proof; our dev VMs are westus2 → wnam.
  const hint = (env.DO_LOCATION_HINT || "enam") as DurableObjectLocationHint;
  return env.VM_SESSIONS.get(env.VM_SESSIONS.idFromName(sandboxId), { locationHint: hint });
}

async function requireApiAuth(request: Request, env: WorkerEnv): Promise<Response | null> {
  return (await tokenMatches(request.headers.get("x-api-key"), env.BENCH_API_TOKEN))
    ? null
    : json({ error: "unauthorized" }, { status: 401 });
}

// VmRoster is the minimal real allocator the single-VM floor test deferred:
// one DO instance holding the fleet of provisioned VM ids with leased/free
// state. create leases (one DO hop — the allocation cost the floor numbers
// omit), DELETE releases. Leases self-expire so a crashed benchmark run can't
// wedge the roster.
const LEASE_TTL_MS = 120_000;

export class VmRoster extends DurableObject<WorkerEnv> {
  private ids: string[] = [];
  private leases = new Map<string, number>(); // id -> leasedAt ms

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ids = (await this.ctx.storage.get<string[]>("ids")) ?? [];
      this.leases = new Map(Object.entries((await this.ctx.storage.get<Record<string, number>>("leases")) ?? {}));
    });
  }

  private persist(): void {
    void this.ctx.storage.put("ids", this.ids);
    void this.ctx.storage.put("leases", Object.fromEntries(this.leases));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    for (const [id, at] of this.leases) if (now - at > LEASE_TTL_MS) this.leases.delete(id);

    if (url.pathname === "/seed" && request.method === "POST") {
      const body = (await request.json()) as { ids?: string[] };
      this.ids = [...new Set(body.ids ?? [])];
      this.leases.clear();
      this.persist();
      return json({ total: this.ids.length });
    }
    if (url.pathname === "/lease" && request.method === "POST") {
      const free = this.ids.find((id) => !this.leases.has(id));
      if (!free) return json({ error: "roster exhausted" }, { status: 409 });
      this.leases.set(free, now);
      this.persist();
      return json({ id: free });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      const body = (await request.json()) as { id?: string };
      if (body.id) {
        this.leases.delete(body.id);
        this.persist();
      }
      return json({ ok: true });
    }
    if (url.pathname === "/known" && request.method === "POST") {
      const body = (await request.json()) as { id?: string };
      return json({ known: !!body.id && this.ids.includes(body.id) });
    }
    if (url.pathname === "/status") {
      return json({ total: this.ids.length, leased: this.leases.size });
    }
    return new Response("not found", { status: 404 });
  }
}

function rosterStub(env: WorkerEnv): DurableObjectStub {
  const hint = (env.DO_LOCATION_HINT || "enam") as DurableObjectLocationHint;
  return env.VM_ROSTER.get(env.VM_ROSTER.idFromName("roster"), { locationHint: hint });
}

// No per-id addressability gate: the bench token is the auth, and the roster's
// job is ALLOCATION (create leases, DELETE releases), not access control. An
// exec against an id with no connected agent fails in the DO ("warm VM is not
// connected") — no roster hop on the hot path.

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, vmId: env.POC_VM_ID });

    const connectMatch = url.pathname.match(/^\/internal\/vms\/([^/]+)\/connect$/);
    if (connectMatch && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // Secret-only auth: agents connect before the roster is seeded (the
      // roster gates the API surface, not the VM-side dial). An id that never
      // joins the roster is simply unreachable.
      if (!(await tokenMatches(socketSecret(request), env.VM_CONNECT_SECRET))) {
        return new Response("unauthorized", { status: 401 });
      }
      return stubFor(env, connectMatch[1]).fetch(new Request("https://do/connect", request));
    }

    const bootstrapMatch = url.pathname.match(/^\/internal\/vms\/([^/]+)\/bootstrap$/);
    if (bootstrapMatch && request.method === "POST") {
      const denied = await requireApiAuth(request, env);
      if (denied) return denied;
      // No roster gate: bootstrap is the provisioning probe and runs BEFORE
      // the id joins the roster (bench-token auth is sufficient).
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

    const locationMatch = url.pathname.match(/^\/internal\/vms\/([^/]+)\/location$/);
    if (locationMatch && request.method === "GET") {
      const denied = await requireApiAuth(request, env);
      if (denied) return denied;
      // No roster gate — same reasoning as bootstrap.
      return stubFor(env, locationMatch[1]).fetch("https://do/location");
    }

    const denied = await requireApiAuth(request, env);
    if (denied) return denied;

    if (url.pathname === "/internal/roster/seed" && request.method === "POST") {
      return rosterStub(env).fetch("https://do/seed", { method: "POST", headers: { "content-type": "application/json" }, body: request.body });
    }
    if (url.pathname === "/internal/roster/status") {
      return rosterStub(env).fetch("https://do/status");
    }

    if (url.pathname === "/api/sandboxes" && request.method === "POST") {
      // Real allocation: lease a VM from the roster (one DO round trip — the
      // cost the single-VM floor test omitted). Falls back to the static
      // single-VM flow when no roster is seeded.
      const startedAt = performance.now();
      let vmId = env.POC_VM_ID;
      const lease = await rosterStub(env).fetch("https://do/lease", { method: "POST" });
      if (lease.ok) {
        vmId = ((await lease.json()) as { id: string }).id;
      } else if (lease.status === 409) {
        const status = await (await rosterStub(env).fetch("https://do/status")).json<{ total: number }>();
        if (status.total > 0) return json({ error: "no VMs available" }, { status: 503 });
        // total 0 → roster never seeded → static single-VM fallback
      }
      return json({
        sandboxID: vmId,
        status: "running",
        templateID: "base",
        connectURL: `${url.origin}/api/sandboxes/${vmId}`,
        token: env.BENCH_API_TOKEN,
        pocTiming: { createEdgeMs: performance.now() - startedAt },
      });
    }

    const sandboxMatch = url.pathname.match(/^\/api\/sandboxes\/([^/]+)$/);
    if (sandboxMatch) {
      if (request.method === "GET") return json({ sandboxID: sandboxMatch[1], status: "running" });
      if (request.method === "DELETE") {
        await rosterStub(env).fetch("https://do/release", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: sandboxMatch[1] }),
        });
        return new Response(null, { status: 204 });
      }
    }

    const execMatch = url.pathname.match(/^\/api\/sandboxes\/([^/]+)\/exec\/run-async$/);
    if (execMatch && request.method === "POST") {
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
