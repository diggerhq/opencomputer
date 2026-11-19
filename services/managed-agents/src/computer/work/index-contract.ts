// The Work index's RPC surface (tech design 3.6, "Interface"), called only by the Work API in the
// stateless Worker (work/api.ts) and by the Computer object (`knowledgeRepository`). Every call
// names the organization (the object is addressed by its account id, like COMPUTERS); every read
// result carries `{ head, asOf, building, problem }`.
//
// Close and Reopen (3.9, build step 5) slot in beside `setRepository`: writes that run inside the
// index's one-at-a-time chain and answer a `WorkWrite`.

import type { RepositoryProblem } from "./github.js";
import type { Stage } from "./item.js";

export type { RepositoryProblem } from "./github.js";

/** The knowledge repository setting, as the API shows it. */
export interface Repository {
  /** The organization's GitHub installation (the Account object's id for it). */
  installationId: string;
  owner: string;
  name: string;
  branch: string;
  /** Set when the repository can no longer be read; the screens send the person to settings. */
  problem: RepositoryProblem | null;
}

/** What `PUT /work/repository` asks for; the branch defaults to the repository's default branch. */
export interface RepositoryChoice {
  installationId: string;
  owner: string;
  name: string;
  branch?: string;
}

/** Who made a write, from the identity the edge asserted. */
export interface WorkActor {
  member: string;
  name: string | null;
  email: string | null;
}

/** On every read: where the projection is and whether it is still being built. */
export interface ReadState {
  /** The commit the projection is at; null before the first build has listed the repository. */
  head: string | null;
  /** When the head was last confirmed against GitHub, ISO; null before. */
  asOf: string | null;
  /** True while the open items of a build are still being read. */
  building: boolean;
  problem: RepositoryProblem | null;
}

/** An item as the index holds it, before the Worker joins sessions and people. */
export interface IndexedItem {
  number: number;
  stage: Stage;
  path: string;
  /** The file on GitHub. */
  url: string;
  title: string;
  stateLine: string | null;
  tags: string[];
  /** The frontmatter owner email, lowercased. */
  owner: string | null;
  /** The author of the commit that added the file; null until the index has seen that commit. */
  author: { name: string; email: string | null } | null;
  left: number | null;
  readyToClose: boolean;
  warnings: string[];
  pullRequests: { url: string; state: "open" | "draft" | "merged" | "closed" | null; title: string | null }[];
  /** Sessions with a commit that touched the file, most recent first. */
  sessionIds: string[];
  updatedAt: string | null;
  createdAt: string | null;
  closedAt: string | null;
  /** The name of the person who closed it; null when unknown or closed in a session. */
  closedBy: string | null;
  /** False while the body has not been read yet (a closed item before its page was asked for). */
  parsed: boolean;
}

export interface ItemsQuery {
  stage: "open" | "closed";
  cursor?: string;
  limit?: number;
}

export type ItemsResult =
  | (ReadState & { ok: true; repository: Repository | null; items: IndexedItem[]; nextCursor: string | null })
  | { ok: false; error: "invalid_cursor" };

export type ItemResult = ReadState & { repository: Repository | null; item: IndexedItem | null; body: string | null };

export interface Revision {
  sha: string;
  url: string;
  at: string;
  authorName: string;
  summary: string;
  sessionId: string | null;
}

export type HistoryResult =
  | (ReadState & { ok: true; revisions: Revision[]; nextCursor: string | null })
  | { ok: false; error: "item_not_found" | "invalid_cursor" | "unavailable"; retryAfterMs?: number };

/** A write's answer: the result, or an API error the Worker forwards. */
export type WorkWrite<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string; field?: string; reason?: string; retryAfterMs?: number };

export interface WorkIndexRpc {
  repository(accountId: string): Promise<Repository | null>;
  setRepository(accountId: string, choice: RepositoryChoice, by: WorkActor): Promise<WorkWrite<Repository>>;
  items(accountId: string, query: ItemsQuery): Promise<ItemsResult>;
  item(accountId: string, number: number): Promise<ItemResult>;
  history(accountId: string, number: number, cursor?: string): Promise<HistoryResult>;
  poke(accountId: string): Promise<void>;
}
