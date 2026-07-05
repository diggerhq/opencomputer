// SpendCounter — a strongly-consistent keyed spend counter + optional hard gate (design 013 §4/§8).
//
// GRAINS (resolved token seam + co-location refinement 2026-07-05). Flue's provider registry is
// isolate-global and CF co-locates many session-DOs of one agent's script in one isolate, so ANY
// per-session data injected via registerProvider (the static token OR an X-OC-Session header) races
// across co-located sessions. Therefore the gateway uses this counter at TWO grains:
//   • HARD (cost-safety boundary): keyed `${org}:${agt}` — race-free because the per-DEPLOY token
//     carries org+agt and nothing per-session. The gateway /check-gates here and returns 402 when over.
//     This matches today's org-level OpenRouter→Autumn model; cost-safety is unchanged.
//   • TRACKING (best-effort): keyed by the X-OC-Session header — the gateway only /add-records here for
//     per-session visibility (dashboard W11) + soft budgets. It NEVER /check-gates a session instance,
//     so a co-location race can never wrongly 402 a legitimate session. Exact per-session enforcement
//     is deferred to an upstream Flue per-request resolver (tracked upstream ask, off the critical path).
//
// The budget is looked up SERVER-SIDE here — NEVER carried in the token. It is set by the control plane
// (POST /provision) or falls back to the gateway's configured default on first /check.
//
// WHY A DO (not KV): enforcement must be read-then-write consistent — concurrent calls (subagents,
// parallel tools) racing on KV would double-spend past the cap. A DO serializes /check and /add.
//
// This counter is for ENFORCEMENT + display ONLY — NOT a billing source. Org-level spend stays on the
// org's single OpenRouter inference key → the existing model_meter cron → Autumn (one cost-source-of-
// truth). Money is integer MICRODOLLARS (µ$, 1e-6 USD) to avoid float drift, matching model_meter.

interface State {
  spent_micro: number;
  budget_micro: number | null; // null = uncapped
  provisioned: boolean; // true once the control plane set an explicit cap (default no longer applies)
  calls: number;
  updated: number;
}

export class SpendCounter {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async load(): Promise<State> {
    const s = await this.state.storage.get<State>("s");
    return s ?? { spent_micro: 0, budget_micro: null, provisioned: false, calls: 0, updated: 0 };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

    // POST /provision {budget_micro} — the control plane sets this grain's explicit cap (W1/W7 seam).
    // `budget_micro: null` = uncapped. Marks it provisioned so the gateway default is ignored.
    if (url.pathname === "/provision") {
      const s = await this.load();
      if (typeof body.budget_micro === "number") s.budget_micro = Math.max(0, Math.round(body.budget_micro));
      else if (body.budget_micro === null) s.budget_micro = null;
      s.provisioned = true;
      s.updated = Date.now();
      await this.state.storage.put("s", s);
      return Response.json({ ok: true, budget_micro: s.budget_micro });
    }

    // POST /check {default_budget_micro?} → GATE a NEW call (used ONLY at the hard org+agt grain). On
    // first sight of an unprovisioned key, adopt the gateway's default cap (server-side; never from the
    // token). Allowed while spent < budget; the last in-flight call can overshoot by at most one call's
    // cost — bounded and acceptable for "refuse past the limit". Runs BEFORE the model call, DO-serialized.
    if (url.pathname === "/check") {
      const s = await this.load();
      if (!s.provisioned && typeof body.default_budget_micro === "number") {
        s.budget_micro = Math.max(0, Math.round(body.default_budget_micro));
      }
      const allowed = s.budget_micro == null || s.spent_micro < s.budget_micro;
      s.updated = Date.now();
      await this.state.storage.put("s", s);
      return Response.json({ allowed, spent_micro: s.spent_micro, budget_micro: s.budget_micro });
    }

    // POST /add {cost_micro, idem} → commit a completed call's cost (from waitUntil, after the response).
    // Called at BOTH grains. Idempotent on the caller's key (an OpenRouter generation id) so a retried
    // meter never double-counts. Each DO instance has its own idem namespace, so the same generation id
    // recorded at the org+agt grain and the session grain does not collide.
    if (url.pathname === "/add") {
      const s = await this.load();
      const costMicro = typeof body.cost_micro === "number" ? Math.max(0, Math.round(body.cost_micro)) : 0;
      const idem = typeof body.idem === "string" ? body.idem : null;
      if (idem) {
        const seen = await this.state.storage.get<boolean>(`idem:${idem}`);
        if (seen) return Response.json({ spent_micro: s.spent_micro, deduped: true });
        await this.state.storage.put(`idem:${idem}`, true);
      }
      s.spent_micro += costMicro;
      s.calls += 1;
      s.updated = Date.now();
      await this.state.storage.put("s", s);
      return Response.json({ spent_micro: s.spent_micro, calls: s.calls });
    }

    // GET /state → spend at this grain (dashboard, §9).
    if (url.pathname === "/state") {
      const s = await this.load();
      return Response.json(s);
    }

    return new Response("not found", { status: 404 });
  }
}
