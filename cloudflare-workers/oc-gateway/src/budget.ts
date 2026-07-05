// SessionBudget — the per-session on-path spend counter + hard-limit gate (design 013 §4/§8).
//
// WHY A DO (and not KV): enforcement must be read-then-write consistent. Concurrent model calls in
// one session (subagents, parallel tools) racing on KV would double-spend past the cap. A DO
// serializes /check and /add per session, so the running total is authoritative. This is the
// "authoritative, not best-effort observe()" the design calls for.
//
// This counter is for ENFORCEMENT + per-session display ONLY — it is NOT a billing source. Org-level
// spend stays on the org's single OpenRouter inference key → the existing model_meter cron → Autumn
// (one cost-source-of-truth, unchanged). The gateway sub-meter and OR's per-key usage are independent
// by design; they need not reconcile to the penny.
//
// Money is tracked in integer MICRODOLLARS (µ$, 1e-6 USD) to avoid float drift, matching model_meter.

interface State {
  spent_micro: number;
  budget_micro: number | null; // null = uncapped
  calls: number;
  updated: number;
}

export class SessionBudget {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async load(): Promise<State> {
    return (await this.state.storage.get<State>("s")) ?? { spent_micro: 0, budget_micro: null, calls: 0, updated: 0 };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

    // POST /check {budget_micro} → set/refresh the cap from the token, return whether a NEW call is
    // allowed (spent < budget). The gate is BEFORE the model call; the last in-flight call can
    // overshoot by at most one call's cost — bounded and acceptable for "refuse past the limit".
    if (url.pathname === "/check") {
      const s = await this.load();
      if (typeof body.budget_micro === "number") s.budget_micro = body.budget_micro;
      else if (body.budget_micro === null) s.budget_micro = null;
      const allowed = s.budget_micro == null || s.spent_micro < s.budget_micro;
      await this.state.storage.put("s", s);
      return Response.json({ allowed, spent_micro: s.spent_micro, budget_micro: s.budget_micro });
    }

    // POST /add {cost_micro} → commit a completed call's cost (called from waitUntil after the
    // response). Idempotency is keyed by the caller (an OpenRouter generation id) so a retried
    // meter never double-counts.
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
      await this.state.storage.put("s", s);
      return Response.json({ spent_micro: s.spent_micro, calls: s.calls });
    }

    // GET /state → per-session spend (dashboard, §9).
    if (url.pathname === "/state") {
      const s = await this.load();
      return Response.json(s);
    }

    return new Response("not found", { status: 404 });
  }
}
