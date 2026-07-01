import type { Http } from "./http.js";

/** The wake condition — the PR state change that wakes the session. */
export type WakeOn = "checks" | "review" | "comment" | "merge";

/** Watch lifecycle status. */
export type WatchStatus = "active" | "closed" | "revoked" | "auth_required";

export interface CreateWatchParams {
  /** Only `"github_pr"` today (the default). */
  type?: string;
  /** `"owner/repo"` — omitted, resolves to the PR this session opened. */
  repo?: string;
  /** PR number — omitted, resolves to the session's sole owned PR. */
  pr?: number;
  /** Wake condition. Default `"checks"`. */
  wakeOn?: WakeOn;
  /** Freeform note ("why"), replayed to the agent on wake. */
  intent?: string;
}

export interface Watch {
  id: string;
  /** `"github_pr"`. */
  type: string;
  /** Watched repo (`"owner/repo"`). */
  repo: string;
  /** Watched PR number. */
  pr: number;
  wakeOn: WakeOn;
  /** Freeform note, replayed on wake. */
  intent?: string;
  status: WatchStatus;
  /** How it was declared (runtime tool / management API). */
  origin: string;
  /** Last authoritative PR re-read. */
  lastSnapshotAt?: string;
  /** When the 30-day TTL lapses; past this the watch stops firing (status stays `active`). */
  expiresAt: string;
  createdAt: string;
}

/**
 * Watches for one session — wake the session when a PR it opened changes (checks finish, a review
 * or comment lands, the PR merges/closes). Management surface; needs the org key.
 *
 * A watch only fires on a PR the **same session** opened via `github_publish_pull_request`, on
 * OpenComputer-App (`oc_app`) repos. See the [Watches guide](https://docs.opencomputer.dev/agent-sessions/watches).
 */
export class Watches {
  constructor(private readonly http: Http, private readonly sessionId: string) {}

  /** Declare a watch. `repo`/`pr` omitted → the PR this session opened. */
  async create(params: CreateWatchParams = {}): Promise<Watch> {
    const r = await this.http.request<{ watch: Watch }>(
      "POST", `/sessions/${this.sessionId}/watches`, { body: params },
    );
    return r.watch;
  }

  /** List this session's watches. */
  async list(): Promise<Watch[]> {
    const r = await this.http.request<{ data?: Watch[] } | Watch[]>(
      "GET", `/sessions/${this.sessionId}/watches`,
    );
    return Array.isArray(r) ? r : r.data ?? [];
  }

  /** Remove a watch (equivalent to the agent's `unwatch_pull_request`). */
  delete(id: string): Promise<void> {
    return this.http.request("DELETE", `/sessions/${this.sessionId}/watches/${id}`);
  }
}
