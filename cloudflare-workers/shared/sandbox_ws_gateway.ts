// SandboxWsGateway — Durable Object per sandbox that brokers SDK and Dashboard
// WebSocket traffic between client and the sandbox's owning cell. One DO
// instance per sandbox_id (deterministically routed via idFromName); the
// instance hosts ≥0 concurrent Sessions, one per inbound WebSocket upgrade.
//
// v7 (multi-session refactor):
//   - Per-session state (clientWs, upstreamWs, queues, isExec, redial flags,
//     execExited) lives on a Session object. v6 stored singletons on the DO
//     instance so a second fetch() to the same sandbox clobbered the first —
//     dashboard + SDK on the same sandbox, or two dashboard tabs, broke. The
//     gateway now keeps `sessions: Set<Session>` and the alarm tick iterates.
//   - The cap-token cache stays on the gateway (per-sandbox shared) — every
//     session in the same DO benefits from a hit.
//   - The exec-output ring buffer (v4) is gone. Cell-side scrollback is a 1MB
//     ring (internal/sandbox/scrollback.go:30) that resends from t=0 on every
//     attach; the DO's 64KB buffer was a strict subset and produced visible
//     duplicate output post-redial. Frame inspection for the 0x03 exit marker
//     stays (still drives v6 exit-suppress).
//   - Migration-aware backoff: when the cell returns 503 + body matches
//     /migrating/, the redial loop drops into a longer cadence (2s × up to
//     30 attempts ≈ 60s wall clock) instead of advancing the normal sequence.
//     Real cross-cell migrations take longer than the 25s default budget;
//     this prevents giving up mid-migration.
//   - Per-session circuit breaker: > REDIAL_FLAP_THRESHOLD startRedial calls
//     within REDIAL_FLAP_WINDOW_MS closes the client with 1011 / "upstream
//     flapping". Prevents an upstream that keeps closing cleanly (e.g. the
//     pre-v6 exec-exit loop) from burning the CF subrequest budget.
//
// v6 carried forward:
//   - 0x03 exit-marker detection on exec/agent. When set, the upstream-close
//     handler closes the client (1000 "exec completed") instead of redialing.
//     Without it the worker re-serves the now-done session on every reattach.
//   - Empty (0-byte) keepalive frames on each alarm tick to both clientWs and
//     upstreamWs, per Session. Defends DO ↔ cell hop against CF Workers
//     fetch-WebSocket idle drop (~100s). Empty frames are no-ops on every
//     receiver (PTY worker: Write(nil); exec worker: len(raw) < 1 continue;
//     SDK/xterm.js consumers: empty data).
//
// v5 carried forward: cap-token caching (per-sandbox, shared across sessions).
//
// v3 carried forward: redial on upstream close. The cell's per-session state
// (PTY/exec session_id) survives WS reconnects, so a fresh upgrade lands on
// the same worker session_id and resumes. Worker restart still loses session
// state — DO sees 404 from the new worker process and closes terminal.
//
// Routing headers the edge MUST set on the inbound request (unchanged):
//   Upgrade: websocket          — required
//   Authorization: Bearer <cap> — cell-bound cap-token minted at the edge
//   X-OC-Cell-URL               — owning cell's base_url
//   X-OC-Cell-Path              — cell-side path incl. query
//   X-OC-Sandbox-Id             — for logging (DO is also named via idFromName)

interface Env {
  OPENCOMPUTER_DB: D1Database;
  SESSION_JWT_SECRET: string;
}

const CTX_KEY = "ctx";
const ALARM_INTERVAL_MS = 30_000;

// Default redial cadence — fast and tight for transient drops.
const REDIAL_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000];
// Migration-aware cadence: cross-cell live migration (VM state transfer) can
// take 30s+ on slow links. Keep retrying at a steadier 2s for ~60s before
// giving up.
const MIGRATION_BACKOFF_MS = 2000;
const MIGRATION_MAX_ATTEMPTS = 30;

// Circuit breaker: redial cycle = one startRedial call (regardless of how
// many internal dial attempts that triggers). After this many cycles within
// the window, give up and close the client.
const REDIAL_FLAP_THRESHOLD = 3;
const REDIAL_FLAP_WINDOW_MS = 60_000;

// Cap-tokens have a 120s exp; refresh 30s ahead so a fresh dial always has
// enough lifetime to complete + a few seconds of margin on the cell side.
const CAP_REFRESH_AHEAD_MS = 30_000;
const CAP_LIFETIME_MS = 120_000;

interface Ctx {
  sandboxID: string;
  // First-session bootstrap state. Each Session also carries its own copy of
  // cellURL/cellPath/capToken; the on-disk Ctx exists so an alarm tick after
  // DO eviction recovers enough context to log meaningfully. Per-session
  // state isn't persisted — sessions don't survive eviction.
  cellURL: string;
  createdAt: number;
  lastTickAt: number;
}

interface CapCacheEntry {
  token: string;
  mintedAt: number;
  orgID: string;
  cellID: string;
  plan: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session — one inbound WS upgrade. Holds the client+upstream socket pair,
// per-direction queues, redial state, exit detection. Created in fetch();
// removed from the gateway's set when the client closes.
// ─────────────────────────────────────────────────────────────────────────────
class Session {
  private clientWs?: WebSocket;
  private upstreamWs?: WebSocket;
  private upQueue: Promise<unknown> = Promise.resolve();
  private downQueue: Promise<unknown> = Promise.resolve();

  // Path-derived flag. Drives v6 exec-exit detection. Re-evaluated never.
  readonly isExec: boolean;

  // v6: exec process exited. Set when the worker's 5-byte 0x03+exitCode frame
  // arrives. On the next upstream close, we close the client cleanly instead
  // of redialing.
  private execExited = false;

  private redialing = false;
  private redialTimes: number[] = []; // wall-clock ms of recent startRedial calls — for circuit breaker

  private cellURL: string;
  private capToken: string;
  private readonly cellPath: string;

  constructor(
    private readonly gateway: SandboxWsGateway,
    readonly sandboxID: string,
    cellURL: string,
    cellPath: string,
    capToken: string,
  ) {
    this.cellURL = cellURL;
    this.cellPath = cellPath;
    this.capToken = capToken;
    this.isExec = /\/(exec|agent)\//.test(cellPath);
  }

  async open(): Promise<Response> {
    const upstreamURL = this.cellURL.replace(/\/$/, "") + this.cellPath;
    const dial = await dialUpstream(upstreamURL, "Bearer " + this.capToken);
    if (!dial.ok) return dial.errResp;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.clientWs = server;
    this.upstreamWs = dial.ws;

    // Seed the gateway cap-token cache from the edge-supplied token so the
    // first redial can reuse it without re-minting.
    const parsed = parseCapToken(this.capToken);
    if (parsed) this.gateway.primeCapCache(this.capToken, parsed);

    // Client side — wired once. Forwarder dereferences this.upstreamWs each
    // frame so a v3 upstream swap during redial is transparent.
    server.addEventListener("message", (e) => {
      const data = e.data;
      this.upQueue = this.upQueue.then(async () => {
        const u = this.upstreamWs;
        if (!u || u.readyState !== 1) return;
        const payload = await normalizeFrame(data, "client→upstream");
        if (payload === null) return;
        try { u.send(payload); } catch (err) {
          console.error(`sandbox-ws-gateway: client→upstream send failed: ${(err as Error).message}`);
        }
      });
    });
    server.addEventListener("close", (e) => {
      this.clientWs = undefined;
      try { this.upstreamWs?.close(e.code || 1000, e.reason || "client closed"); } catch {}
      this.gateway.removeSession(this);
    });
    server.addEventListener("error", (e: Event) => {
      const msg = (e as ErrorEvent)?.message ?? "unknown";
      if (!msg.includes("Network connection lost")) {
        console.error(`sandbox-ws-gateway: client error: ${msg}`);
      }
      try { this.upstreamWs?.close(1011, "client error"); } catch {}
    });

    this.wireUpstreamListeners(dial.ws);

    dial.ws.accept();
    server.accept();

    console.log(
      `sandbox-ws-gateway: opened sandbox=${this.sandboxID} cell=${this.cellURL} path=${this.cellPath} sessions_now=${this.gateway.sessionCount()}`,
    );

    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  // Empty binary frame on both sockets every alarm tick. Keeps middleboxes
  // (CF Workers fetch-WS idle, NAT) from idling a long-quiet session out.
  // Empty frames are safe on every receiver — see file header for proof.
  keepalive(): void {
    const empty = new ArrayBuffer(0);
    if (this.clientWs && this.clientWs.readyState === 1) {
      try { this.clientWs.send(empty); } catch (err) {
        console.error(`sandbox-ws-gateway: client keepalive send failed: ${(err as Error).message}`);
      }
    }
    if (this.upstreamWs && this.upstreamWs.readyState === 1) {
      try { this.upstreamWs.send(empty); } catch (err) {
        console.error(`sandbox-ws-gateway: upstream keepalive send failed: ${(err as Error).message}`);
      }
    }
  }

  hasOpenSockets(): boolean {
    const c = !!this.clientWs && this.clientWs.readyState === 1;
    const u = !!this.upstreamWs && this.upstreamWs.readyState === 1;
    return c || u;
  }

  state(): string {
    const c = !!this.clientWs && this.clientWs.readyState === 1 ? "open" : "closed";
    const u = !!this.upstreamWs && this.upstreamWs.readyState === 1 ? "open" : "closed";
    return `client=${c} upstream=${u}${this.redialing ? " redialing" : ""}${this.execExited ? " exec-exited" : ""}`;
  }

  // Wire upstream → client forwarding, close-triggers-redial, error filter.
  // Called once on initial fetch() and again on each redial's new upstream.
  private wireUpstreamListeners(upstream: WebSocket): void {
    upstream.addEventListener("message", (e) => {
      const data = e.data;
      this.downQueue = this.downQueue.then(async () => {
        // Guard against frames from a stale upstream after a redial swap.
        if (this.upstreamWs !== upstream) return;
        const c = this.clientWs;
        if (!c || c.readyState !== 1) return;
        const payload = await normalizeFrame(data, "upstream→client");
        if (payload === null) return;
        // v6: detect the worker's exec-exit marker — 5-byte binary frame
        // tagged 0x03 with the 4-byte exit code. Worker sends once per
        // session.Done branch (handlers.go) then closes 1000.
        if (
          this.isExec &&
          payload instanceof ArrayBuffer &&
          payload.byteLength === 5 &&
          new Uint8Array(payload)[0] === 0x03
        ) {
          this.execExited = true;
        }
        try { c.send(payload); } catch (err) {
          console.error(`sandbox-ws-gateway: upstream→client send failed: ${(err as Error).message}`);
        }
      });
    });
    upstream.addEventListener("close", (e) => {
      if (this.upstreamWs !== upstream) return;
      this.upstreamWs = undefined;
      if (!this.clientWs || this.clientWs.readyState !== 1) return;
      if (this.execExited) {
        console.log(`sandbox-ws-gateway: exec exited — closing client (upstream code=${e.code}) sandbox=${this.sandboxID}`);
        try { this.clientWs.close(1000, "exec completed"); } catch {}
        this.clientWs = undefined;
        this.gateway.removeSession(this);
        return;
      }
      void this.startRedial(`upstream close code=${e.code} reason=${e.reason || "(none)"}`);
    });
    upstream.addEventListener("error", (e: Event) => {
      const msg = (e as ErrorEvent)?.message ?? "unknown";
      if (!msg.includes("Network connection lost")) {
        console.error(`sandbox-ws-gateway: upstream error: ${msg}`);
      }
      // Close handler fires after error; redial happens there.
    });
  }

  private async startRedial(reason: string): Promise<void> {
    if (this.redialing) return;

    // Circuit breaker — give up if upstream is flapping. Bound the array so
    // recent-only window stays cheap. Threshold itself is reached on the
    // (N+1)-th call within the window: keep up to N recent timestamps.
    const now = Date.now();
    this.redialTimes = this.redialTimes.filter((t) => now - t < REDIAL_FLAP_WINDOW_MS);
    if (this.redialTimes.length >= REDIAL_FLAP_THRESHOLD) {
      console.log(
        `sandbox-ws-gateway: redial flap threshold hit sandbox=${this.sandboxID} ` +
        `(${this.redialTimes.length} cycles in ${Math.round((now - this.redialTimes[0]) / 1000)}s) — closing client`,
      );
      try { this.clientWs?.close(1011, "upstream flapping"); } catch {}
      this.clientWs = undefined;
      this.gateway.removeSession(this);
      return;
    }
    this.redialTimes.push(now);

    this.redialing = true;
    console.log(`sandbox-ws-gateway: redial start sandbox=${this.sandboxID} cycle=${this.redialTimes.length} — ${reason}`);
    try {
      const handled = await this.runRedial();
      if (!handled) {
        console.log(`sandbox-ws-gateway: redial exhausted sandbox=${this.sandboxID} — closing client`);
        try { this.clientWs?.close(1011, "upstream unrecoverable"); } catch {}
        this.clientWs = undefined;
        this.gateway.removeSession(this);
      }
    } catch (e) {
      console.error(`sandbox-ws-gateway: redial threw: ${(e as Error).message}`);
      try { this.clientWs?.close(1011, "redial error"); } catch {}
      this.clientWs = undefined;
      this.gateway.removeSession(this);
    } finally {
      this.redialing = false;
    }
  }

  // Returns true when the situation was handled — redial succeeded, or the
  // sandbox is officially gone and we closed the client cleanly. False ⇒
  // ran out of attempts; caller closes with an unrecoverable reason.
  private async runRedial(): Promise<boolean> {
    const env = this.gateway.envHandle();
    const sbRow = await env.OPENCOMPUTER_DB.prepare(
      "SELECT cell_id, org_id, status FROM sandboxes_index WHERE id = ?1",
    ).bind(this.sandboxID).first<{ cell_id: string; org_id: string; status: string }>();
    if (!sbRow) {
      console.log(`sandbox-ws-gateway: redial: sandbox ${this.sandboxID} not in sandboxes_index`);
      try { this.clientWs?.close(1000, "sandbox not found"); } catch {}
      this.clientWs = undefined;
      this.gateway.removeSession(this);
      return true;
    }
    if (sbRow.status === "stopped" || sbRow.status === "failed") {
      console.log(`sandbox-ws-gateway: redial: sandbox ${this.sandboxID} status=${sbRow.status} — closing client`);
      try { this.clientWs?.close(1000, `sandbox ${sbRow.status}`); } catch {}
      this.clientWs = undefined;
      this.gateway.removeSession(this);
      return true;
    }
    const cellRow = await env.OPENCOMPUTER_DB.prepare(
      "SELECT base_url FROM cells WHERE cell_id = ?1",
    ).bind(sbRow.cell_id).first<{ base_url: string }>();
    if (!cellRow) {
      console.log(`sandbox-ws-gateway: redial: cell ${sbRow.cell_id} not in cells table`);
      return false;
    }
    const orgRow = await env.OPENCOMPUTER_DB.prepare(
      "SELECT plan FROM orgs WHERE id = ?1",
    ).bind(sbRow.org_id).first<{ plan: string }>();
    const plan = orgRow?.plan === "pro" ? "pro" : "free";

    if (cellRow.base_url !== this.cellURL) {
      console.log(`sandbox-ws-gateway: redial: sandbox moved cell ${this.cellURL} → ${cellRow.base_url}`);
    }

    // Adaptive backoff: start with the fast sequence, but on the first 503
    // /migrating/ response switch to the steadier migration cadence for the
    // rest of the cycle. Switching back and forth would be noisy and pointless.
    let inMigrationMode = false;
    let attempt = 0;
    const maxAttempts = REDIAL_BACKOFF_MS.length;

    while (true) {
      const delay = inMigrationMode
        ? MIGRATION_BACKOFF_MS
        : REDIAL_BACKOFF_MS[Math.min(attempt, REDIAL_BACKOFF_MS.length - 1)];
      const limit = inMigrationMode ? MIGRATION_MAX_ATTEMPTS : maxAttempts;
      if (attempt >= limit) return false;

      await sleep(delay);
      if (!this.clientWs || this.clientWs.readyState !== 1) {
        console.log(`sandbox-ws-gateway: redial: client gone during backoff, abort`);
        return true;
      }

      const capToken = await this.gateway.getOrMintCapToken(sbRow.org_id, sbRow.cell_id, plan);
      const upstreamURL = cellRow.base_url.replace(/\/$/, "") + this.cellPath;
      console.log(
        `sandbox-ws-gateway: redial: attempt ${attempt + 1}/${limit}${inMigrationMode ? " (migrating)" : ""} sandbox=${this.sandboxID} → ${upstreamURL}`,
      );

      const dial = await dialUpstream(upstreamURL, `Bearer ${capToken}`);
      if (!dial.ok) {
        console.log(`sandbox-ws-gateway: redial: attempt ${attempt + 1} failed — ${dial.note}`);
        if (dial.terminal) {
          const reason = dial.body.toLowerCase().includes("stopped")
            ? "sandbox stopped"
            : `cell ${dial.status ?? "gone"}`;
          console.log(`sandbox-ws-gateway: redial: terminal (status=${dial.status}) — closing client (${reason})`);
          try { this.clientWs?.close(1000, reason); } catch {}
          this.clientWs = undefined;
          this.gateway.removeSession(this);
          return true;
        }
        if (dial.migrating && !inMigrationMode) {
          console.log(`sandbox-ws-gateway: redial: cell reports migrating — switching to migration backoff (${MIGRATION_BACKOFF_MS}ms × ${MIGRATION_MAX_ATTEMPTS})`);
          inMigrationMode = true;
          attempt = 0;
          continue;
        }
        attempt++;
        continue;
      }

      // Success. No buffer replay (cell scrollback covers it).
      this.upstreamWs = dial.ws;
      this.cellURL = cellRow.base_url;
      this.capToken = capToken;
      this.wireUpstreamListeners(dial.ws);
      dial.ws.accept();
      console.log(`sandbox-ws-gateway: redial: success on attempt ${attempt + 1} sandbox=${this.sandboxID}`);
      return true;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable Object entry point. One instance per sandboxID, ≥0 Sessions inside.
// ─────────────────────────────────────────────────────────────────────────────
export class SandboxWsGateway {
  private sessions: Set<Session> = new Set();
  private cachedCap?: CapCacheEntry;

  constructor(private state: DurableObjectState, private env: Env) {}

  // Internal accessors used by Session — keeps env private to this class
  // while letting the Session reach D1 and the cap-token cache.
  envHandle(): Env { return this.env; }
  sessionCount(): number { return this.sessions.size; }
  removeSession(s: Session): void { this.sessions.delete(s); }

  primeCapCache(token: string, parsed: { orgID: string; cellID: string; plan: string; iat: number }): void {
    this.cachedCap = {
      token,
      mintedAt: parsed.iat * 1000,
      orgID: parsed.orgID,
      cellID: parsed.cellID,
      plan: parsed.plan,
    };
  }

  async getOrMintCapToken(orgID: string, cellID: string, plan: string): Promise<string> {
    const now = Date.now();
    if (
      this.cachedCap &&
      this.cachedCap.orgID === orgID &&
      this.cachedCap.cellID === cellID &&
      this.cachedCap.plan === plan &&
      now - this.cachedCap.mintedAt < CAP_LIFETIME_MS - CAP_REFRESH_AHEAD_MS
    ) {
      console.log(
        `sandbox-ws-gateway: cap-token cache hit (age=${Math.floor((now - this.cachedCap.mintedAt) / 1000)}s, org=${orgID}, cell=${cellID})`,
      );
      return this.cachedCap.token;
    }
    const token = await mintCapToken(this.env.SESSION_JWT_SECRET, orgID, cellID, plan, null);
    this.cachedCap = { token, mintedAt: now, orgID, cellID, plan };
    console.log(`sandbox-ws-gateway: cap-token minted (org=${orgID}, cell=${cellID}, plan=${plan})`);
    return token;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 400 });
    }
    const cellURL = req.headers.get("x-oc-cell-url");
    const cellPath = req.headers.get("x-oc-cell-path");
    const auth = req.headers.get("authorization");
    const sandboxID = req.headers.get("x-oc-sandbox-id") || "";
    if (!cellURL || !cellPath || !auth) {
      return new Response(
        "sandbox-ws-gateway: missing routing headers (x-oc-cell-url, x-oc-cell-path, authorization)",
        { status: 400 },
      );
    }

    const session = new Session(this, sandboxID, cellURL, cellPath, auth.replace(/^Bearer\s+/i, ""));
    const resp = await session.open();
    if (resp.status === 101) {
      this.sessions.add(session);
      // Make sure the alarm is armed. setAlarm is idempotent for a given
      // time, and we always set it to now + interval — overlapping calls
      // just re-set the next tick, never multiplying alarms.
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      // Persist a minimal ctx so post-eviction alarm logs still know the sandbox.
      const ctx: Ctx = {
        sandboxID,
        cellURL,
        createdAt: Date.now(),
        lastTickAt: Date.now(),
      };
      await this.state.storage.put(CTX_KEY, ctx);
    }
    return resp;
  }

  async alarm(): Promise<void> {
    const ctx = await this.state.storage.get<Ctx>(CTX_KEY);

    // Reap sessions whose sockets are all closed but never called removeSession
    // (defensive — close handlers should already have removed them).
    for (const s of [...this.sessions]) {
      if (!s.hasOpenSockets()) this.sessions.delete(s);
    }

    if (this.sessions.size === 0) {
      console.log(`sandbox-ws-gateway: alarm sandbox=${ctx?.sandboxID || "?"} — idle, releasing`);
      await this.state.storage.deleteAll();
      return;
    }

    for (const s of this.sessions) s.keepalive();

    const summary = [...this.sessions]
      .map((s) => `[${s.isExec ? "exec" : "pty"} ${s.state()}]`)
      .join(" ");
    console.log(
      `sandbox-ws-gateway: alarm sandbox=${ctx?.sandboxID || "?"} sessions=${this.sessions.size} ${summary}`,
    );

    if (ctx) {
      ctx.lastTickAt = Date.now();
      await this.state.storage.put(CTX_KEY, ctx);
    }
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface DialFailure {
  ok: false;
  terminal: boolean;     // 404/410 — cell says the resource is permanently gone
  migrating: boolean;    // 503 + body contains "migrating" — wait longer
  status?: number;
  body: string;
  errResp: Response;
  note: string;
}

interface DialSuccess {
  ok: true;
  ws: WebSocket;
}

async function dialUpstream(upstreamURL: string, authHeader: string): Promise<DialSuccess | DialFailure> {
  let resp: Response;
  try {
    resp = await fetch(upstreamURL, {
      headers: { Upgrade: "websocket", Authorization: authHeader },
    });
  } catch (e) {
    const note = `upstream fetch threw: ${(e as Error).message}`;
    console.error(`sandbox-ws-gateway: ${note}`);
    return {
      ok: false,
      terminal: false,
      migrating: false,
      body: "",
      errResp: new Response(`cell websocket fetch failed: ${(e as Error).message}`, { status: 502 }),
      note,
    };
  }
  const ws = (resp as Response & { webSocket?: WebSocket }).webSocket;
  if (ws) return { ok: true, ws };

  const errBody = (await resp.text().catch(() => "")).slice(0, 200);
  const terminal = resp.status === 404 || resp.status === 410;
  const migrating = resp.status === 503 && /migrating/i.test(errBody);
  const note =
    `status=${resp.status} body=${errBody}` +
    (terminal ? " (terminal)" : "") +
    (migrating ? " (migrating)" : "");
  console.error(`sandbox-ws-gateway: no webSocket on response ${note}`);
  return {
    ok: false,
    terminal,
    migrating,
    status: resp.status,
    body: errBody,
    errResp: new Response(`cell websocket connect failed (status ${resp.status}): ${errBody}`, { status: 502 }),
    note,
  };
}

// Normalize an inbound WebSocket frame to a payload we can both send and
// inspect for the exit marker. CF delivers binary frames as Blob on non-
// hibernatable WSes, so we await blob.arrayBuffer() before returning.
async function normalizeFrame(data: unknown, label: string): Promise<ArrayBuffer | string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    const ab = new ArrayBuffer(v.byteLength);
    new Uint8Array(ab).set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    return ab;
  }
  if (data && typeof (data as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === "function") {
    try {
      return await (data as Blob).arrayBuffer();
    } catch (e) {
      console.error(`sandbox-ws-gateway: ${label}: blob.arrayBuffer failed: ${(e as Error).message}`);
      return null;
    }
  }
  console.error(`sandbox-ws-gateway: ${label}: unknown data shape: ${typeof data} ${(data as { constructor?: { name?: string } })?.constructor?.name}`);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function mintCapToken(
  secret: string,
  orgID: string,
  cellID: string,
  plan: string,
  userID: string | null,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    sub: orgID,
    iss: "opensandbox-edge",
    iat: now,
    exp: now + 120,
    org_id: orgID,
    cell_id: cellID,
    plan,
  };
  if (userID) payload.user_id = userID;
  const enc = new TextEncoder();
  const signingInput =
    b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

function parseCapToken(token: string): { orgID: string; cellID: string; plan: string; iat: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? b64 + "=".repeat(4 - (b64.length % 4)) : b64;
    const payload = JSON.parse(atob(pad)) as {
      org_id?: string; cell_id?: string; plan?: string; iat?: number;
    };
    if (!payload.org_id || !payload.cell_id || !payload.plan || typeof payload.iat !== "number") return null;
    return { orgID: payload.org_id, cellID: payload.cell_id, plan: payload.plan, iat: payload.iat };
  } catch {
    return null;
  }
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge-side helper — unchanged signature for callers in index.ts / dashboard.ts.
// ─────────────────────────────────────────────────────────────────────────────

export async function routeWsViaGateway(opts: {
  ns: DurableObjectNamespace;
  sandboxID: string;
  originalRequest: Request;
  capToken: string;
  cellBaseURL: string;
  cellPath: string;
}): Promise<Response> {
  const stub = opts.ns.get(opts.ns.idFromName(opts.sandboxID));
  const url = new URL(opts.originalRequest.url);
  url.searchParams.delete("api_key");
  const fwd = new Request(url.toString(), opts.originalRequest);
  fwd.headers.set("authorization", "Bearer " + opts.capToken);
  fwd.headers.delete("x-api-key");
  fwd.headers.set("x-oc-cell-url", opts.cellBaseURL);
  fwd.headers.set("x-oc-cell-path", opts.cellPath);
  fwd.headers.set("x-oc-sandbox-id", opts.sandboxID);
  return await stub.fetch(fwd);
}
