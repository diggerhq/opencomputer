/**
 * CreditAccount Durable Object.
 *
 * Per-org wallet for free-tier credits. One instance per org_id, globally
 * strongly consistent (DOs give us a single-writer guarantee), so concurrent
 * debits from the ingest Worker and admin flows don't race.
 *
 * State lives in DO storage keyed under `state`. Events that have already
 * been processed are deduped via a bounded LRU of recent event IDs; this
 * guarantees at-most-once debit under the at-least-once event stream.
 *
 * Endpoints (all POST except /snapshot):
 *   /check            → { allowed, balance_cents }
 *   /debit            → { balance_cents, halted } body: { cost_cents, event_id }
 *   /credit           → body: { amount_cents }
 *   /mark-pro         → body: { skip_resume? }
 *   /snapshot (GET)   → full state
 *
 * Halt/resume dispatch: when balance crosses zero, or when mark-pro lands
 * with hibernated sandboxes still on file, the DO queries D1 sandboxes_index
 * for cells the org has sandboxes in and POSTs /admin/halt-org or
 * /admin/resume-org to each. Failures are logged — the CP's halt_reconciler
 * is the safety net.
 */

export interface CreditAccountEnv {
  OPENCOMPUTER_DB: D1Database;
  CF_ADMIN_SECRET: string; // HMAC shared with regional CPs
  // Optional: comma-separated list of CP admin URLs keyed by cell_id, e.g.
  // "dev-cell-a=http://localhost:8080". Used when D1 has no cell_endpoints
  // table yet. In production this will be replaced by a lookup.
  CELL_ENDPOINTS?: string;
}

interface AccountState {
  org_id: string;
  plan: "free" | "pro";
  balance_cents: number;          // seeded to 500 on first init; -1 once plan="pro"
  lifetime_spent_cents: number;
  status: "active" | "halted_credits" | "suspended";
  halted_at?: number;
  last_debit_at?: number;
}

const INITIAL_FREE_BALANCE_CENTS = 500; // $5
const PROCESSED_EVENT_LRU_SIZE = 1024;
const STATE_KEY = "state";
const PROCESSED_KEY = "processed_event_ids";

export class CreditAccount {
  private readonly state: DurableObjectState;
  private readonly env: CreditAccountEnv;
  private readonly orgId: string;

  constructor(state: DurableObjectState, env: CreditAccountEnv) {
    this.state = state;
    this.env = env;
    // DO IDs are opaque, but we stash org_id inside storage on first touch so
    // dispatch calls can identify the account without the caller having to
    // re-send it on every RPC. The first init via /check or /debit sets it.
    this.orgId = state.id.toString();
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case "/check":
          return await this.handleCheck(req);
        case "/debit":
          return await this.handleDebit(req);
        case "/credit":
          return await this.handleCredit(req);
        case "/mark-pro":
          return await this.handleMarkPro(req);
        case "/snapshot":
          return await this.handleSnapshot();
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (err) {
      console.error("credit_account error:", err);
      return new Response(`internal error: ${String(err)}`, { status: 500 });
    }
  }

  // --- Handlers -----------------------------------------------------------

  private async handleCheck(req: Request): Promise<Response> {
    const body = (await safeJson(req)) as { org_id?: string } | null;
    const state = await this.loadOrInit(body?.org_id);
    const allowed = state.plan === "pro" || state.balance_cents > 0;
    return Response.json({ allowed, balance_cents: state.balance_cents, plan: state.plan });
  }

  private async handleDebit(req: Request): Promise<Response> {
    const body = (await safeJson(req)) as {
      org_id?: string;
      cost_cents?: number;
      event_id?: string;
    } | null;
    if (!body || typeof body.cost_cents !== "number" || !body.event_id) {
      return new Response("missing cost_cents or event_id", { status: 400 });
    }
    const state = await this.loadOrInit(body.org_id);

    // Idempotency: reject duplicate event IDs.
    const processed = (await this.state.storage.get<string[]>(PROCESSED_KEY)) ?? [];
    if (processed.includes(body.event_id)) {
      return Response.json({
        balance_cents: state.balance_cents,
        halted: state.status === "halted_credits",
        deduped: true,
      });
    }

    // Pro accounts don't debit. The ingest Worker should have skipped them but
    // we're defensive here.
    if (state.plan === "pro") {
      await this.recordProcessedEvent(processed, body.event_id);
      return Response.json({ balance_cents: -1, halted: false, plan: "pro" });
    }

    state.balance_cents = Math.max(0, state.balance_cents - body.cost_cents);
    state.lifetime_spent_cents += body.cost_cents;
    state.last_debit_at = Date.now();

    let justHalted = false;
    if (state.balance_cents <= 0 && state.status !== "halted_credits") {
      state.status = "halted_credits";
      state.halted_at = Date.now();
      justHalted = true;
    }

    await this.save(state);
    await this.recordProcessedEvent(processed, body.event_id);

    if (justHalted) {
      await this.dispatchHalt(state.org_id, "credits_exhausted");
    }

    return Response.json({
      balance_cents: state.balance_cents,
      halted: state.status === "halted_credits",
    });
  }

  private async handleCredit(req: Request): Promise<Response> {
    const body = (await safeJson(req)) as { org_id?: string; amount_cents?: number } | null;
    if (!body || typeof body.amount_cents !== "number" || body.amount_cents <= 0) {
      return new Response("missing positive amount_cents", { status: 400 });
    }
    const state = await this.loadOrInit(body.org_id);

    const wasHalted = state.status === "halted_credits";
    state.balance_cents = (state.plan === "pro" ? 0 : state.balance_cents) + body.amount_cents;
    if (wasHalted && state.balance_cents > 0) {
      state.status = "active";
      delete state.halted_at;
    }
    await this.save(state);

    if (wasHalted && state.balance_cents > 0) {
      await this.dispatchResume(state.org_id);
    }

    return Response.json({ balance_cents: state.balance_cents, status: state.status });
  }

  private async handleMarkPro(req: Request): Promise<Response> {
    const body = (await safeJson(req)) as { org_id?: string; skip_resume?: boolean } | null;
    const state = await this.loadOrInit(body?.org_id);

    const wasHalted = state.status === "halted_credits";
    state.plan = "pro";
    state.balance_cents = -1;
    state.status = "active";
    delete state.halted_at;
    await this.save(state);

    // Also mirror the plan change to D1 so api-edge's hot path reads see it.
    await this.env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO orgs (id, plan, created_at, updated_at) VALUES (?, 'pro', ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan = 'pro', updated_at = excluded.updated_at`,
    )
      .bind(state.org_id, Date.now(), Date.now())
      .run();

    if (wasHalted && !body?.skip_resume) {
      await this.dispatchResume(state.org_id);
    }
    return Response.json({ plan: "pro", resumed: wasHalted && !body?.skip_resume });
  }

  private async handleSnapshot(): Promise<Response> {
    const state = await this.state.storage.get<AccountState>(STATE_KEY);
    if (!state) {
      return Response.json({ initialized: false });
    }
    return Response.json(state);
  }

  // --- Storage helpers ----------------------------------------------------

  private async loadOrInit(callerOrgId?: string): Promise<AccountState> {
    let state = await this.state.storage.get<AccountState>(STATE_KEY);
    if (state) return state;

    // First-touch init: seed $5 for free tier. The caller must pass org_id
    // because DO names alone don't round-trip through Cloudflare's storage
    // API as human-readable IDs.
    const orgId = callerOrgId ?? this.orgId;
    state = {
      org_id: orgId,
      plan: "free",
      balance_cents: INITIAL_FREE_BALANCE_CENTS,
      lifetime_spent_cents: 0,
      status: "active",
    };
    await this.save(state);
    return state;
  }

  private async save(state: AccountState): Promise<void> {
    await this.state.storage.put(STATE_KEY, state);
  }

  private async recordProcessedEvent(list: string[], eventId: string): Promise<void> {
    const next = [...list, eventId];
    if (next.length > PROCESSED_EVENT_LRU_SIZE) {
      next.splice(0, next.length - PROCESSED_EVENT_LRU_SIZE);
    }
    await this.state.storage.put(PROCESSED_KEY, next);
  }

  // --- Dispatch -----------------------------------------------------------

  private async dispatchHalt(orgId: string, reason: string): Promise<void> {
    const cells = await this.orgCells(orgId, "running");
    await Promise.all(cells.map((cell) => this.callCellAdmin(cell, "/admin/halt-org", { org_id: orgId, reason })));
  }

  private async dispatchResume(orgId: string): Promise<void> {
    const cells = await this.orgCells(orgId, "hibernated");
    await Promise.all(cells.map((cell) => this.callCellAdmin(cell, "/admin/resume-org", { org_id: orgId })));
  }

  private async orgCells(orgId: string, status: string): Promise<string[]> {
    const { results } = await this.env.OPENCOMPUTER_DB.prepare(
      `SELECT DISTINCT cell_id FROM sandboxes_index WHERE org_id = ? AND status = ?`,
    )
      .bind(orgId, status)
      .all<{ cell_id: string }>();
    return (results ?? []).map((r) => r.cell_id);
  }

  private async callCellAdmin(
    cellId: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const endpoint = this.resolveCellEndpoint(cellId);
    if (!endpoint) {
      console.warn(`credit_account: no endpoint for cell ${cellId}, dropping ${path}`);
      return;
    }
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await hmacHex(this.env.CF_ADMIN_SECRET, `${ts}.${body}`);
    try {
      const resp = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Timestamp": ts,
          "X-Signature": sig,
        },
        body,
      });
      if (!resp.ok) {
        console.warn(`credit_account: ${path} → ${endpoint} returned ${resp.status}`);
      }
    } catch (err) {
      console.warn(`credit_account: ${path} → ${endpoint} failed: ${String(err)}`);
    }
  }

  private resolveCellEndpoint(cellId: string): string | null {
    const raw = this.env.CELL_ENDPOINTS ?? "";
    for (const pair of raw.split(",")) {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (k === cellId && v) return v;
    }
    return null;
  }
}

// --- Utilities -------------------------------------------------------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    const text = await req.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
