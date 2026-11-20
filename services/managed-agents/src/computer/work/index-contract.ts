// The Work index's RPC surface (tech design 3.6, "Interface"), called only by the Work API in the
// stateless Worker (work/api.ts) and by the Computer object (`knowledgeRepository`). Every call
// names the organization (the object is addressed by its account id, like COMPUTERS); every read
// result carries `{ head, asOf, building, version, problem, problemMessage }`.
//
// Close and Reopen (3.9, build step 5) slot in beside `setRepository`: writes that run inside the
// index's one-at-a-time chain and answer a `WorkWrite`.

import type { GrantedRepository, RepositoryProblem } from "./github.js";
import type { Stage } from "./item.js";

export type { GrantedRepository, RepositoryProblem } from "./github.js";

/** The knowledge repository setting, as the API shows it. */
export interface Repository {
  /** The organization's GitHub installation (the Account object's id for it). */
  installationId: string;
  owner: string;
  name: string;
  branch: string;
  /** Set when the repository can no longer be read; the screens send the person to settings. A stable code. */
  problem: RepositoryProblem | null;
  /** The problem in words, for people; null without a problem. */
  problemMessage: string | null;
}

/** What `PUT /work/repository` asks for; the branch defaults to the repository's default branch. */
export interface RepositoryChoice {
  installationId: string;
  owner: string;
  name: string;
  branch?: string;
}

/** One of the organization's active GitHub installations, with what it grants, for the picker. */
export interface GrantingInstallation {
  /** The Account object's id for it: a `RepositoryChoice`'s `installationId`. */
  id: string;
  accountLogin: string;
  /** GitHub's `Organization` or `User`. */
  accountType: string;
  /** The installation's page on GitHub, where a person grants it more repositories. */
  settingsUrl: string;
  /** This page of them, most recently pushed first; never pushed last. */
  repositories: GrantedRepository[];
  /** The page holding more of them, or null on the last. */
  nextPage: number | null;
  /** True when the installation grants more than the pages a listing reads. */
  truncated: boolean;
  /** Set when GitHub would not list them (the repositories are then empty). A stable code. */
  problem: RepositoryProblem | null;
  problemMessage: string | null;
}

/** The last page a listing reads: 10,000 repositories an installation. */
export const GRANTED_PAGES_MAX = 100;

/** Which page to list, of every installation or of one (`GrantingInstallation.id`). */
export interface RepositoriesQuery {
  installationId?: string;
  page?: number;
}

export type RepositoriesResult = { ok: true; installations: GrantingInstallation[] } | { ok: false; error: "unavailable"; retryAfterMs: number };

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
  /** Moves whenever anything a list shows changes (rows, pull request state, the problem). */
  version: number;
  problem: RepositoryProblem | null;
  problemMessage: string | null;
}

/** What the open list's ETag is made of, read without composing the list. */
export interface OpenStamp {
  head: string | null;
  asOf: string | null;
  version: number;
  /** How many open items changed within RECENT_DAYS: moves when one ages out, with no commit. */
  recent: number;
}

/**
 * Who owns an item. `declared`: the frontmatter `owner:`. `derived`: the author of the latest commit
 * that touched the file and was not a bulk edit, else of its latest commit of any kind.
 */
export interface IndexedOwner {
  /** Lowercased. */
  email: string;
  /** The commit author's name without " via Computer"; null for a declared owner. */
  name: string | null;
  source: "declared" | "derived";
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
  /** Declared, else derived from the commits; null when neither is known. */
  owner: IndexedOwner | null;
  /** The author of the commit that added the file; null until the index has seen that commit. */
  author: { name: string; email: string | null } | null;
  left: number | null;
  readyToClose: boolean;
  warnings: string[];
  pullRequests: { url: string; state: "open" | "draft" | "merged" | "closed" | null; title: string | null }[];
  /** Sessions with a commit that touched the file, most recent first. */
  sessionIds: string[];
  updatedAt: string | null;
  /** The latest commit that touched the file and was not a bulk edit (BULK_ITEMS); null when none is read. */
  lastActivityAt: string | null;
  /** `lastActivityAt` is within RECENT_DAYS of now. */
  recent: boolean;
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

export type ItemResult =
  | (ReadState & { ok: true; repository: Repository | null; item: IndexedItem | null; body: string | null })
  /** The body is not read yet and GitHub did not give it within the read's wait. */
  | { ok: false; error: "unavailable"; retryAfterMs: number };

/** The items whose commits name one of a session's references in a `Session:` trailer. */
export type LinkedResult = ReadState & { ok: true; repository: Repository | null; items: IndexedItem[] };

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
  repositories(accountId: string, query?: RepositoriesQuery): Promise<RepositoriesResult>;
  items(accountId: string, query: ItemsQuery): Promise<ItemsResult>;
  item(accountId: string, number: number): Promise<ItemResult>;
  history(accountId: string, number: number, cursor?: string): Promise<HistoryResult>;
  /** Open and closed items linked to any of `refs` (a session's public id and its runner key), by number. */
  linked(accountId: string, refs: string[]): Promise<LinkedResult>;
  poke(accountId: string): Promise<void>;
  stamp(accountId: string): Promise<OpenStamp>;
}
