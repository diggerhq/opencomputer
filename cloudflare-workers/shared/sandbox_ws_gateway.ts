// SandboxWsGateway — Durable Object per sandbox that brokers SDK and Dashboard
// WebSocket traffic between client and the sandbox's owning cell. One DO
// instance per sandbox_id (deterministically routed via idFromName).
//
// v5 adds: cap-token caching inside the DO.
//   - The edge mints a 120s HS256 cap-token on every WS upgrade and puts it
//     in the Authorization header. v5 parses that JWT (org_id / cell_id /
//     plan / iat live in the payload) and stores it as a typed cache entry.
//   - On v3 redial, getOrMintCapToken returns the cached token when it still
//     matches the current (org, cell, plan) and has > 30s of life left. Only
//     re-mints when stale or when the sandbox genuinely moved cells. That
//     turns a 10-attempt redial backoff loop from 10 mints into 0–1 mints,
//     and re-opens within the same DO instance reuse the edge's token
//     without the DO ever minting.
//   - Cache is in-memory only — it's reseeded from ctx.capToken on each new
//     fetch(), and re-mints are cheap (single HMAC) so survival across DO
//     eviction isn't worth the storage write churn.
//
// v4 adds: output ring buffer + replay-on-redial for exec/agent sessions.
//   - Exec sessions (path contains /exec/) keep the last ~64 KB of
//     upstream→client frames in a ring buffer (ArrayBuffer[] with a running
//     byte count). PTY sessions skip the buffer — they're live terminals;
//     users re-type if anything was lost.
//   - On successful v3 redial, the DO replays the entire buffer to the
//     client BEFORE the new upstream is accept()ed. Sync sends queue into
//     the client WS in order, so live frames from the new upstream arrive
//     strictly after the replay.
//   - The buffer is NOT cleared after replay — a session that takes multiple
//     redials gets gap-free output every time. The eviction policy keeps
//     the steady-state size bounded.
//   - In-memory only; we don't persist to state.storage because the DO is
//     non-hibernatable while live WSes are held (v2 finding). If we ever
//     gain a way to hibernate one side, periodic snapshots into storage are
//     the natural follow-up.
//
// v3 adds: redial on upstream close.
//   - When the upstream WS closes, the DO does NOT close the client. Instead it
//     re-resolves the sandbox's current cell from D1 (sandboxes_index +
//     cells), mints a fresh cap-token, and dials the cell again with
//     exponential backoff (250ms → 4s, ~10 attempts).
//   - If D1 reports status ∈ {stopped, failed}, the DO closes the client with
//     a clear reason instead of retrying.
//   - The client→upstream forwarder dereferences this.upstreamWs on every
//     frame, so swapping the upstream during a redial is transparent on the
//     client side. Frames sent during the redial window are dropped (v4 will
//     buffer them).
//   - Known limitation: if the cell-side per-session state was wiped (e.g. a
//     worker restart kills the PTY session_id), the redial completes the WS
//     connect but the cell may immediately close it again. We log that case
//     loudly and exhaust the backoff before giving up.
//
// v2 carried forward: alarm tick + state.storage persistence + log-noise
// filter. CF's Hibernatable WS API only accepts the server half of a
// WebSocketPair (not the upstream from fetch()), so the bridge still uses
// standard addEventListener; holding live WSes keeps the DO from being
// evicted, which is enough for long-idle sessions.
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
const REDIAL_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000];
const MAX_BUFFER_BYTES = 64 * 1024;
// Cap-tokens have a 120s exp; refresh 30s ahead so a fresh dial always has
// enough lifetime to complete + a few seconds of margin on the cell side.
const CAP_REFRESH_AHEAD_MS = 30_000;
const CAP_LIFETIME_MS = 120_000;

interface Ctx {
  sandboxID: string;
  cellURL: string;
  cellPath: string;
  capToken: string;
  capTokenMintedAt: number;
  createdAt: number;
  lastTickAt: number;
}

export class SandboxWsGateway {
  // Live WSes for the current session. Survive across alarm() ticks because
  // CF keeps the DO instance in memory while non-hibernatable sockets are
  // open. Cleared on close so alarm can detect "session ended" and tear
  // storage down.
  private clientWs?: WebSocket;
  private upstreamWs?: WebSocket;
  private redialing = false;

  // Per-direction serial queues preserve frame ordering across the Blob →
  // ArrayBuffer await chain. Kept as instance state so they survive across
  // upstream swaps during a redial (client→upstream ordering must hold even
  // as the target socket changes).
  private upQueue: Promise<unknown> = Promise.resolve();
  private downQueue: Promise<unknown> = Promise.resolve();

  // v4: Output ring buffer for exec/agent sessions. Holds normalized
  // upstream→client frames. Bounded by MAX_BUFFER_BYTES; oldest frames are
  // evicted when the cap is exceeded. PTY sessions skip the buffer (isExec
  // stays false).
  private isExec = false;
  private outputBuffer: (ArrayBuffer | string)[] = [];
  private outputBufferBytes = 0;

  // v5: cap-token cache. The edge mints a 120s HS256 JWT and passes it via
  // the Authorization header on every fetch; we parse the payload once so
  // we know what (org, cell, plan) it's bound to and can decide whether to
  // reuse it instead of re-minting during a v3 redial.
  private cachedCap?: { token: string; mintedAt: number; orgID: string; cellID: string; plan: string };

  constructor(private state: DurableObjectState, private env: Env) {}

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

    // /exec/ and /agent/ paths use the framed exec protocol — enable the
    // v4 ring buffer so a successful redial can replay missed output. /pty/
    // is a live terminal; users re-type, so we skip the buffer.
    this.isExec = /\/(exec|agent)\//.test(cellPath);

    const upstream = await this.dialUpstream(cellURL.replace(/\/$/, "") + cellPath, auth);
    if (!upstream.ok) return upstream.errResp;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.clientWs = server;
    this.upstreamWs = upstream.ws;

    const now = Date.now();
    const ctx: Ctx = {
      sandboxID,
      cellURL,
      cellPath,
      capToken: auth.replace(/^Bearer\s+/i, ""),
      capTokenMintedAt: now,
      createdAt: now,
      lastTickAt: now,
    };
    await this.state.storage.put(CTX_KEY, ctx);

    // v5: prime the cap-token cache from the edge-supplied token. parseCapToken
    // returns null if the JWT doesn't decode cleanly — in that case we just
    // leave the cache empty and the first redial will mint fresh.
    const parsed = parseCapToken(ctx.capToken);
    if (parsed) {
      this.cachedCap = {
        token: ctx.capToken,
        mintedAt: parsed.iat * 1000,
        orgID: parsed.orgID,
        cellID: parsed.cellID,
        plan: parsed.plan,
      };
    }

    // Client side — wired once. The message listener dereferences
    // this.upstreamWs dynamically so a v3 upstream swap is transparent.
    server.addEventListener("message", (e) => {
      const data = e.data;
      this.upQueue = this.upQueue.then(async () => {
        const u = this.upstreamWs;
        // Dropped during a v3 redial. The v4 buffer only covers upstream→client
        // (output); client keystrokes/stdin during the redial window are lost
        // by design.
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
    });
    server.addEventListener("error", (e: Event) => {
      const msg = (e as ErrorEvent)?.message ?? "unknown";
      if (!msg.includes("Network connection lost")) {
        console.error(`sandbox-ws-gateway: client error: ${msg}`);
      }
      try { this.upstreamWs?.close(1011, "client error"); } catch {}
    });

    // Upstream side — wired here AND re-wired on each successful redial.
    this.wireUpstreamListeners(upstream.ws, server);

    upstream.ws.accept();
    server.accept();

    await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);

    console.log(
      `sandbox-ws-gateway: opened sandbox=${sandboxID} cell=${cellURL} path=${cellPath}`,
    );

    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  // Wire upstream→client forwarding, close-triggers-redial, and error filter.
  // Called once on initial fetch() and again on each redial's new upstream.
  private wireUpstreamListeners(upstream: WebSocket, server: WebSocket): void {
    upstream.addEventListener("message", (e) => {
      const data = e.data;
      this.downQueue = this.downQueue.then(async () => {
        const c = this.clientWs;
        if (!c || c.readyState !== 1) return;
        const payload = await normalizeFrame(data, "upstream→client");
        if (payload === null) return;
        // v4: capture for replay on next redial (exec/agent only).
        if (this.isExec) this.appendToBuffer(payload);
        try { c.send(payload); } catch (err) {
          console.error(`sandbox-ws-gateway: upstream→client send failed: ${(err as Error).message}`);
        }
      });
    });
    upstream.addEventListener("close", (e) => {
      // Only act if this is still the *current* upstream — during a redial we
      // may swap upstreams and the OLD one fires close after the swap.
      if (this.upstreamWs !== upstream) return;
      this.upstreamWs = undefined;
      if (!this.clientWs || this.clientWs.readyState !== 1) return;
      // v3: trigger redial. Fire-and-forget — runRedial holds its own error
      // path. We deliberately do NOT close the client here.
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

  // v5: return a cap-token bound to (orgID, cellID, plan). Reuses the cached
  // token when it matches and has > 30s of life left; mints + caches a
  // fresh one otherwise. Called by runRedial — fresh fetches don't go through
  // this path because the edge mints unconditionally.
  private async getOrMintCapToken(orgID: string, cellID: string, plan: string): Promise<string> {
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

  // v4: append a normalized upstream→client frame to the ring buffer for
  // replay on a future redial. Evicts oldest frames once the byte cap is
  // exceeded. Only called when this.isExec is true.
  private appendToBuffer(payload: ArrayBuffer | string): void {
    const size = typeof payload === "string" ? payload.length : payload.byteLength;
    this.outputBuffer.push(payload);
    this.outputBufferBytes += size;
    while (this.outputBufferBytes > MAX_BUFFER_BYTES && this.outputBuffer.length > 0) {
      const dropped = this.outputBuffer.shift()!;
      this.outputBufferBytes -= typeof dropped === "string" ? dropped.length : dropped.byteLength;
    }
  }

  private async startRedial(reason: string): Promise<void> {
    if (this.redialing) return;
    this.redialing = true;
    console.log(`sandbox-ws-gateway: redial start — ${reason}`);
    try {
      const handled = await this.runRedial();
      if (!handled) {
        console.log(`sandbox-ws-gateway: redial exhausted — closing client`);
        try { this.clientWs?.close(1011, "upstream unrecoverable"); } catch {}
        this.clientWs = undefined;
      }
    } catch (e) {
      console.error(`sandbox-ws-gateway: redial threw: ${(e as Error).message}`);
      try { this.clientWs?.close(1011, "redial error"); } catch {}
      this.clientWs = undefined;
    } finally {
      this.redialing = false;
    }
  }

  // Returns true if the situation was handled (either redial succeeded or the
  // sandbox is officially gone and we closed the client cleanly). Returns
  // false if we ran out of backoff attempts without success — the caller
  // closes the client with an unrecoverable reason.
  private async runRedial(): Promise<boolean> {
    const ctx = await this.state.storage.get<Ctx>(CTX_KEY);
    if (!ctx) {
      console.error("sandbox-ws-gateway: redial: no ctx in storage");
      return false;
    }

    const sbRow = await this.env.OPENCOMPUTER_DB.prepare(
      "SELECT cell_id, org_id, status FROM sandboxes_index WHERE id = ?1",
    ).bind(ctx.sandboxID).first<{ cell_id: string; org_id: string; status: string }>();

    if (!sbRow) {
      console.log(`sandbox-ws-gateway: redial: sandbox ${ctx.sandboxID} not in sandboxes_index`);
      try { this.clientWs?.close(1000, "sandbox not found"); } catch {}
      this.clientWs = undefined;
      return true;
    }
    if (sbRow.status === "stopped" || sbRow.status === "failed") {
      console.log(`sandbox-ws-gateway: redial: sandbox ${ctx.sandboxID} status=${sbRow.status} — closing client`);
      try { this.clientWs?.close(1000, `sandbox ${sbRow.status}`); } catch {}
      this.clientWs = undefined;
      return true;
    }

    const cellRow = await this.env.OPENCOMPUTER_DB.prepare(
      "SELECT base_url FROM cells WHERE cell_id = ?1",
    ).bind(sbRow.cell_id).first<{ base_url: string }>();
    if (!cellRow) {
      console.log(`sandbox-ws-gateway: redial: cell ${sbRow.cell_id} not in cells table`);
      return false;
    }

    const orgRow = await this.env.OPENCOMPUTER_DB.prepare(
      "SELECT plan FROM orgs WHERE id = ?1",
    ).bind(sbRow.org_id).first<{ plan: string }>();
    const plan = orgRow?.plan === "pro" ? "pro" : "free";

    const cellMoved = cellRow.base_url !== ctx.cellURL;
    if (cellMoved) {
      console.log(`sandbox-ws-gateway: redial: sandbox moved cell ${ctx.cellURL} → ${cellRow.base_url}`);
    }

    for (let i = 0; i < REDIAL_BACKOFF_MS.length; i++) {
      await sleep(REDIAL_BACKOFF_MS[i]);
      if (!this.clientWs || this.clientWs.readyState !== 1) {
        console.log(`sandbox-ws-gateway: redial: client gone during backoff, abort`);
        return true;
      }

      // v5: cached if it still matches (org, cell, plan) and has > 30s left.
      const capToken = await this.getOrMintCapToken(sbRow.org_id, sbRow.cell_id, plan);
      const upstreamURL = cellRow.base_url.replace(/\/$/, "") + ctx.cellPath;
      console.log(`sandbox-ws-gateway: redial: attempt ${i + 1}/${REDIAL_BACKOFF_MS.length} → ${upstreamURL}`);

      const dial = await this.dialUpstream(upstreamURL, `Bearer ${capToken}`);
      if (!dial.ok) {
        console.log(`sandbox-ws-gateway: redial: attempt ${i + 1} failed — ${dial.note}`);
        if (dial.terminal) {
          // Cell explicitly said the resource is gone (404/410). No point
          // burning the rest of the backoff — close the client with the
          // cell's reason so the SDK gets a clear signal.
          const reason = dial.body.toLowerCase().includes("stopped")
            ? "sandbox stopped"
            : `cell ${dial.status ?? "gone"}`;
          console.log(`sandbox-ws-gateway: redial: terminal (status=${dial.status}) — closing client (${reason})`);
          try { this.clientWs?.close(1000, reason); } catch {}
          this.clientWs = undefined;
          return true;
        }
        continue;
      }

      // Success. Order matters here:
      //   1. Replay the v4 ring buffer to the client BEFORE wiring or
      //      accepting the new upstream. Sync sends queue into the client WS
      //      in order, so any live frames from the new upstream arrive after.
      //   2. Set this.upstreamWs so the client→upstream forwarder picks up
      //      the new socket.
      //   3. Wire upstream→client listeners.
      //   4. accept() the new upstream — messages start flowing.
      // The buffer is NOT cleared after replay; a session that takes more
      // than one redial still gets gap-free output every time.
      if (this.isExec && this.outputBuffer.length > 0 && this.clientWs && this.clientWs.readyState === 1) {
        console.log(
          `sandbox-ws-gateway: redial: replaying ${this.outputBufferBytes}B (${this.outputBuffer.length} frames) to client`,
        );
        for (const frame of this.outputBuffer) {
          try { this.clientWs.send(frame); } catch (err) {
            console.error(`sandbox-ws-gateway: redial replay send failed: ${(err as Error).message}`);
            break;
          }
        }
      }
      this.upstreamWs = dial.ws;
      ctx.cellURL = cellRow.base_url;
      ctx.capToken = capToken;
      ctx.capTokenMintedAt = Date.now();
      await this.state.storage.put(CTX_KEY, ctx);
      this.wireUpstreamListeners(dial.ws, this.clientWs);
      dial.ws.accept();
      console.log(`sandbox-ws-gateway: redial: success on attempt ${i + 1}`);
      return true;
    }
    return false;
  }

  // Shared upstream dial used by both fetch() and runRedial(). Returns either
  // a live WS, a "terminal" failure (cell explicitly says the resource is gone —
  // 404 or 410 — which the redial loop treats as unrecoverable), or a transient
  // failure that the redial loop should keep retrying with backoff.
  private async dialUpstream(
    upstreamURL: string,
    authHeader: string,
  ): Promise<
    | { ok: true; ws: WebSocket }
    | { ok: false; terminal: boolean; status?: number; body: string; errResp: Response; note: string }
  > {
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
        body: "",
        errResp: new Response(`cell websocket fetch failed: ${(e as Error).message}`, { status: 502 }),
        note,
      };
    }
    const ws = (resp as Response & { webSocket?: WebSocket }).webSocket;
    if (ws) return { ok: true, ws };

    const errBody = (await resp.text().catch(() => "")).slice(0, 200);
    // 404 Not Found and 410 Gone are explicit "this resource is permanently
    // unavailable" signals — the cell knows the sandbox is stopped/missing.
    // Retrying just waits out the backoff to no purpose.
    const terminal = resp.status === 404 || resp.status === 410;
    const note = `status=${resp.status} body=${errBody}${terminal ? " (terminal)" : ""}`;
    console.error(`sandbox-ws-gateway: no webSocket on response ${note}`);
    return {
      ok: false,
      terminal,
      status: resp.status,
      body: errBody,
      errResp: new Response(`cell websocket connect failed (status ${resp.status}): ${errBody}`, { status: 502 }),
      note,
    };
  }

  async alarm(): Promise<void> {
    const clientOpen = !!this.clientWs && this.clientWs.readyState === 1;
    const upstreamOpen = !!this.upstreamWs && this.upstreamWs.readyState === 1;
    const ctx = await this.state.storage.get<Ctx>(CTX_KEY);

    if (!clientOpen && !upstreamOpen && !this.redialing) {
      console.log(`sandbox-ws-gateway: alarm sandbox=${ctx?.sandboxID || "?"} — idle, releasing`);
      await this.state.storage.deleteAll();
      return;
    }

    const bufferInfo = this.isExec
      ? ` buffer=${this.outputBufferBytes}B/${this.outputBuffer.length}f`
      : "";
    console.log(
      `sandbox-ws-gateway: alarm sandbox=${ctx?.sandboxID || "?"} client=${clientOpen ? "open" : "closed"} upstream=${upstreamOpen ? "open" : "closed"}${this.redialing ? " redialing" : ""}${bufferInfo}`,
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

// Normalize an inbound WebSocket frame to a payload we can both send and
// store in the v4 buffer. CF delivers binary frames as Blob on non-
// hibernatable WSes, so we await blob.arrayBuffer() before returning.
// Strings pass through. Returns null on unknown shapes — caller drops.
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

// Mint the cell-bound capability token the regional CP expects. Mirrors the
// edge's mintCapToken in api-edge/src/index.ts — HS256 JWT signed with
// SESSION_JWT_SECRET, iss=opensandbox-edge, 120s exp. Used by v3 redial when
// the original edge-minted token has expired or the sandbox moved cells.
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

// parseCapToken decodes the payload segment of an HS256 cap-token JWT and
// extracts the cell-binding claims. No signature check — the edge minted it
// upstream of us; we just need the routing keys (org_id, cell_id, plan) and
// the issue timestamp so the v5 cache can decide freshness. Returns null on
// anything malformed; callers fall back to a fresh mint.
function parseCapToken(token: string): { orgID: string; cellID: string; plan: string; iat: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // JWT b64url → standard b64 → JSON
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
// Edge-side helper
// ─────────────────────────────────────────────────────────────────────────────

// routeWsViaGateway — edge-side helper. Sends a WS upgrade request through the
// per-sandbox DO instance with the routing headers the DO expects. Used by
// both the SDK proxy path (index.ts proxyToCellSDK) and the Dashboard PTY
// path (dashboard.ts proxyWebSocket) so the two surfaces share one code path.
//
// The api_key query param is stripped from the cloned request URL before
// handing it to the DO — the DO reads cap-token from Authorization, never the
// URL, and we don't want the long-lived SDK key flowing into DO logs/storage.
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
