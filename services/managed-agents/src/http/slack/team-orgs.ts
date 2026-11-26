// Which organization a Slack workspace is linked to, remembered in front of the team router (the
// Slack object `slack-team:<teamId>`, else Computer's old `computer-slack-team:<teamId>`), so that
// most Slack events skip that Durable Object round trip. A cache, never the truth: two layers, the
// isolate's memory for a minute, then the colo's Cache API (`caches.default`) for five. Slack's
// traffic is spread over many isolates, so memory alone would mostly miss; the colo layer is shared
// by every isolate there.
//
// Stale is bounded and harmless: a release (unlink, a revoked token, a relink elsewhere) forgets the
// workspace in this isolate and this colo at once; elsewhere a link is believed for at most the
// colo's five minutes plus an isolate's minute. A workspace relinked meanwhile reaches the old
// organization's Slack actor, which answers `unlinked` for a team it no longer holds; the route then
// forgets it and asks the router again. Only links are remembered: an unlinked workspace is asked
// about every time, so a new install works at once.

export const TEAM_ORG_TTL_MS = 60_000;
export const TEAM_ORG_COLO_TTL_S = 300;
const MAX_ENTRIES = 1_000;

/** A layer shared beyond the isolate (the colo's cache). Failures are the caller's misses. */
export interface SharedTeamOrgs {
  get(teamId: string): Promise<string | null>;
  put(teamId: string, org: string): Promise<void>;
  delete(teamId: string): Promise<void>;
}

/** Where a lookup was answered: `memory`, `colo`, or null (the router). */
export type TeamCacheLayer = "memory" | "colo" | null;

export interface TeamLookup {
  org: string | null;
  cached: TeamCacheLayer;
}

/** The colo's Cache API as a SharedTeamOrgs, under a private key per workspace. */
export function coloTeamOrgs(cache: Cache, ttlS = TEAM_ORG_COLO_TTL_S): SharedTeamOrgs {
  const key = (teamId: string) => new Request(`https://computer-team-links.internal/v1/${encodeURIComponent(teamId)}`);
  return {
    async get(teamId) {
      const hit = await cache.match(key(teamId));
      const org = hit ? (await hit.text()).trim() : "";
      return org || null;
    },
    async put(teamId, org) {
      await cache.put(key(teamId), new Response(org, { headers: { "cache-control": `max-age=${ttlS}`, "content-type": "text/plain" } }));
    },
    async delete(teamId) {
      await cache.delete(key(teamId));
    },
  };
}

export class TeamOrgCache {
  private readonly entries = new Map<string, { org: string; until: number }>();

  constructor(
    private readonly ttlMs = TEAM_ORG_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly shared: () => SharedTeamOrgs | null = () => null,
  ) {}

  /** The linked organization: from memory, the colo, or `lookup` (remembered in both when there is one). */
  async get(teamId: string, lookup: () => Promise<string | null>): Promise<TeamLookup> {
    const entry = this.entries.get(teamId);
    if (entry && entry.until > this.now()) return { org: entry.org, cached: "memory" };
    const shared = this.sharedLayer();
    const fromColo = shared ? await shared.get(teamId).catch(() => null) : null;
    if (fromColo) {
      this.rememberHere(teamId, fromColo);
      return { org: fromColo, cached: "colo" };
    }
    const org = await lookup();
    if (org) await this.remember(teamId, org);
    else this.entries.delete(teamId);
    return { org, cached: null };
  }

  async remember(teamId: string, org: string): Promise<void> {
    this.rememberHere(teamId, org);
    await this.sharedLayer()?.put(teamId, org).catch(() => {});
  }

  async forget(teamId: string): Promise<void> {
    this.entries.delete(teamId);
    await this.sharedLayer()?.delete(teamId).catch(() => {});
  }

  private rememberHere(teamId: string, org: string): void {
    this.entries.delete(teamId);
    if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(teamId, { org, until: this.now() + this.ttlMs });
  }

  private sharedLayer(): SharedTeamOrgs | null {
    try {
      return this.shared();
    } catch {
      return null;
    }
  }
}
