// Which organization a Slack workspace is linked to, remembered so that most
// Slack events skip the workspace's link object (`computer-slack-team:<teamId>`),
// a Durable Object round trip that `message.received` and the delivery
// waited for. Two layers: the isolate's memory for a minute, then the colo's
// Cache API (`caches.default`) for five. Slack's traffic is spread over many
// isolates, so memory alone would mostly miss; the colo layer is shared by
// every isolate there.
//
// Stale is harmless: a workspace relinked to another organization reaches the
// old organization's object, which refuses a team it is not linked to
// (`acceptSlackEvent`, `slackInteraction`; the routes then forget the team),
// and a linked workspace is never moved by a claim (`claimTeam`), only after
// a release, which forgets it here and in this colo. Only links are
// remembered: an unlinked workspace is asked about every time, so a new
// install works at once.

export const TEAM_ACCOUNT_TTL_MS = 60_000;
export const TEAM_LINK_COLO_TTL_S = 300;
const MAX_ENTRIES = 1_000;

/** A layer shared beyond the isolate (the colo's cache). Failures are the caller's misses. */
export interface SharedTeamLinks {
  get(teamId: string): Promise<string | null>;
  put(teamId: string, accountId: string): Promise<void>;
  delete(teamId: string): Promise<void>;
}

/** Where a lookup was answered: `memory`, `colo`, or null (the link object). */
export type TeamCacheLayer = "memory" | "colo" | null;

export interface TeamLookup {
  accountId: string | null;
  cached: TeamCacheLayer;
}

/** The colo's Cache API as a SharedTeamLinks, under a private key per workspace. */
export function coloTeamLinks(cache: Cache, ttlS = TEAM_LINK_COLO_TTL_S): SharedTeamLinks {
  const key = (teamId: string) => new Request(`https://computer-team-links.internal/v1/${encodeURIComponent(teamId)}`);
  return {
    async get(teamId) {
      const hit = await cache.match(key(teamId));
      const accountId = hit ? (await hit.text()).trim() : "";
      return accountId || null;
    },
    async put(teamId, accountId) {
      await cache.put(key(teamId), new Response(accountId, { headers: { "cache-control": `max-age=${ttlS}`, "content-type": "text/plain" } }));
    },
    async delete(teamId) {
      await cache.delete(key(teamId));
    },
  };
}

export class TeamAccountCache {
  private readonly entries = new Map<string, { accountId: string; until: number }>();

  constructor(
    private readonly ttlMs = TEAM_ACCOUNT_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly shared: () => SharedTeamLinks | null = () => null,
  ) {}

  /** The linked organization: from memory, the colo, or `lookup` (remembered in both when there is one). */
  async get(teamId: string, lookup: () => Promise<string | null>): Promise<TeamLookup> {
    const entry = this.entries.get(teamId);
    if (entry && entry.until > this.now()) return { accountId: entry.accountId, cached: "memory" };
    const shared = this.sharedLayer();
    const fromColo = shared ? await shared.get(teamId).catch(() => null) : null;
    if (fromColo) {
      this.rememberHere(teamId, fromColo);
      return { accountId: fromColo, cached: "colo" };
    }
    const accountId = await lookup();
    if (accountId) await this.remember(teamId, accountId);
    else this.entries.delete(teamId);
    return { accountId, cached: null };
  }

  async remember(teamId: string, accountId: string): Promise<void> {
    this.rememberHere(teamId, accountId);
    await this.sharedLayer()?.put(teamId, accountId).catch(() => {});
  }

  async forget(teamId: string): Promise<void> {
    this.entries.delete(teamId);
    await this.sharedLayer()?.delete(teamId).catch(() => {});
  }

  private rememberHere(teamId: string, accountId: string): void {
    this.entries.delete(teamId);
    if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(teamId, { accountId, until: this.now() + this.ttlMs });
  }

  private sharedLayer(): SharedTeamLinks | null {
    try {
      return this.shared();
    } catch {
      return null;
    }
  }
}
