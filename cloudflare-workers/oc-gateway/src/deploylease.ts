// DeployLease — the per-(org, agt) lease-epoch floor that fences a rotated or revoked deploy token
// (design 013 §4 / buildout W3 "lease-epoch fence"). Keyed by `${org}:${agt}`.
//
// The deploy token (token.ts) carries a monotonic `ep` (deploy epoch, minted by W7). This DO holds
// the current floor for an (org, agt):
//   - GATE: a token whose `ep` is BELOW the floor is fenced (superseded). A token at/above the floor
//     is admitted and RAISES the floor to its `ep` — so the moment a redeploy's higher-epoch token is
//     first used, every still-in-flight older-epoch token stops verifying. This is the rotation fence,
//     automatic, no control-plane action required.
//   - BUMP: the control plane raises the floor explicitly to REVOKE without a redeploy (e.g. a leaked
//     token): POST /bump {min_epoch} sets floor = max(floor, min_epoch). To revoke epoch E, bump to E+1.
//
// A DO (not KV) so the floor is read-then-write consistent under concurrent calls. A token with no
// `ep` skips the fence entirely (lenient — the fence is opt-in on the mint side).

interface Lease {
  floor: number; // highest deploy epoch admitted / bumped; a token with ep < floor is fenced
  updated: number;
}

export class DeployLease {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async load(): Promise<Lease> {
    const l = await this.state.storage.get<Lease>("l");
    return l ?? { floor: 0, updated: 0 };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

    // POST /gate {ep?} → { ok, fenced, floor }. Fence ep < floor; adopt (raise floor) on ep >= floor.
    if (url.pathname === "/gate") {
      const l = await this.load();
      const ep = typeof body.ep === "number" ? body.ep : null;
      if (ep == null) return Response.json({ ok: true, fenced: false, floor: l.floor }); // no epoch → no fence
      if (ep < l.floor) return Response.json({ ok: false, fenced: true, floor: l.floor });
      if (ep > l.floor) {
        l.floor = ep;
        l.updated = Date.now();
        await this.state.storage.put("l", l);
      }
      return Response.json({ ok: true, fenced: false, floor: l.floor });
    }

    // POST /bump {min_epoch} → raise the floor for an explicit revocation. floor = max(floor, min_epoch).
    if (url.pathname === "/bump") {
      const l = await this.load();
      const min = typeof body.min_epoch === "number" ? Math.round(body.min_epoch) : null;
      if (min != null && min > l.floor) {
        l.floor = min;
        l.updated = Date.now();
        await this.state.storage.put("l", l);
      }
      return Response.json({ floor: l.floor });
    }

    // GET /state → the current floor (ops / dashboard).
    if (url.pathname === "/state") {
      const l = await this.load();
      return Response.json(l);
    }

    return new Response("not found", { status: 404 });
  }
}
