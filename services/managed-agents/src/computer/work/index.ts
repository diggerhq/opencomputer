// The Work index (work tracking, tech design 3.6): one organization's projection of its knowledge
// repository's `work/` and `done/` folders, kept in SQLite and moved forward from a cursor commit.
// The repository is the record; this is a cache that can always be rebuilt from it.
//
// - Advance (the only way the projection changes, besides a build), from the cursor to the head:
//   1. compare `cursor...head` (one call): not ahead means a rewritten history, so rebuild. When
//      it lists fewer than 300 files, that list is the change.
//   2. Otherwise the trees: the head's root tree, and each of `work/` and `done/` whose tree sha
//      differs from the one stored at the cursor (2-3 calls), diffed against the `files` table.
//   3. The blobs of the changed items only, then rows, files and the cursor in one transaction.
//      Changed rows lose `updatedAt`, a new close loses `closedAt`/`closedBy`: null until the walk
//      fills them, never a guess. A range of one commit fills them at once from compare's files.
//   4. The walk (below) gets the range when it changed an item file: compare's commits (the first
//      page is in hand, the rest are a range task) and up to ADVANCE_DETAILS commit details now,
//      the rest from the alarm. The range is compare's, not the folders' listings back to a commit
//      already listed: those are ordered by date, and a merged branch's commits dated before the
//      cursor would be missed. Merge commits are not detailed: their files repeat the branch's.
//   Whatever the range's size, an advance never rebuilds and stays within those calls.
// - Build (no cursor, or a rewritten history): list the two folders at the head; open items are
//   read in batches of 50 continued by the alarm, and the cursor is set when they are done. Closed
//   items get a row from the listing and are read when a page of them is asked for. Dates,
//   authors and links come from the walk.
// - The walk: after a build, `commits?path=work` and `commits?path=done` from its head to the root
//   (a page of 100 at a time); after an advance, the range's commits from compare. Then each listed
//   commit's files (one call each, newest first, within the quota). A commit's files give its items' revisions (history),
//   links (`Session:` trailers), the add (author, created), the move into done/ (closed) and the
//   latest change (updated).
// - Duplicate numbers: `files` holds every item file at the cursor; the row of a number is its open
//   file before a closed one, then the first path. The others show as a warning naming them.
// - One GitHub task at a time (`exclusive`): look, build, fill, walk, pull state, setRepository.
//   Reads never wait on it: they are SQL, and the two that may need GitHub (an item or a page of
//   closed items not read yet, history while the walk is not done) wait at most READ_WAIT_MS. Every
//   GitHub request is aborted after 10 s, so a hung one holds the chain no longer than that.
//   Listing what the installations grant (the repository picker) stores nothing and is outside it.
// - A permanent failure is stored as `problem` (a code) and `problemMessage`; it is retried from
//   the alarm with a backoff from PROBLEM_RETRY_MS to PROBLEM_RETRY_MAX_MS and cleared on success.
//   An installation the Account object no longer has (removed, not just refusing a token) is final
//   (`problem_final`): the alarm stops, and only a read or a new setting looks again.
// - No alarm loops without progress: a blob or a commit GitHub will not give is asked again with a
//   backoff (`failures`) and given up after FAILURE_TRIES, with a warning; an alarm that moved
//   nothing while there is no cursor (a first build that failed) or a build waits longer each time
//   (`stall`), up to PROBLEM_RETRY_MAX_MS. An organization with no repository arms no alarm.
//
// Close and Reopen (3.9, build step 5) are writes in the same chain: a commit through the
// contents API, then an advance to it.

import {
  GitHubGone,
  GitHubPaused,
  GitHubUnavailable,
  PER_PAGE_MAX,
  pullOf,
  WorkGitHub,
  type CommitInfo,
  type FileChange,
  type GrantedRepository,
  type RepositoryProblem,
  type TokenMinter,
  type WorkRepo,
} from "./github.js";
import type {
  HistoryResult,
  IndexedItem,
  IndexedOwner,
  ItemResult,
  ItemsQuery,
  ItemsResult,
  LinkedResult,
  OpenStamp,
  GrantingInstallation,
  ReadState,
  RepositoriesResult,
  Repository,
  RepositoryChoice,
  Revision,
  WorkActor,
  WorkWrite,
} from "./index-contract.js";
import { itemPath, PARSER_VERSION, parseItem, readyToClose, sessionTrailers, slugTitle, type ItemPath, type ParsedItem } from "./item.js";
import { within, type Clock, type Fetch, type IndexStore, type Scheduler, type StoreValue } from "./platform.js";

/** A read finding the head older than this looks behind its response. */
export const LOOK_AFTER_MS = 10_000;
/** The alarm looks this often while there have been reads in the last READS_WINDOW_MS. */
export const ALARM_EVERY_MS = 60_000;
export const READS_WINDOW_MS = 10 * 60_000;
/** Between two batches of a build. */
const BUILD_STEP_MS = 1_000;
export const FILL_BATCH = 50;
/** Pull request state is asked at most this often. */
export const PULLS_EVERY_MS = 5 * 60_000;
export const PULLS_PER_QUERY = 50;
/** A pull request GitHub would not show is asked again after this. */
export const UNREADABLE_RECHECK_MS = 24 * 60 * 60_000;
/** Compare lists at most this many files; at that many, the list may be cut. */
export const COMPARE_FILES_MAX = 300;
/** Commit details an advance asks itself; the alarm asks the rest. */
export const ADVANCE_DETAILS = 10;
/** Per alarm without readers: pages of folder commits, and commit details. */
export const WALK_PAGES_PER_TICK = 2;
export const WALK_DETAILS_PER_TICK = 10;
/** A read that needs GitHub answers within this, or 503 `unavailable`. */
export const READ_WAIT_MS = 5_000;
/** A stored problem is retried after this, doubling each time up to the maximum. */
export const PROBLEM_RETRY_MS = 60_000;
export const PROBLEM_RETRY_MAX_MS = 60 * 60_000;
/** A blob or commit that fails is asked again after this, doubling; given up after FAILURE_TRIES. */
export const FAILURE_RETRY_MS = 60_000;
export const FAILURE_TRIES = 8;
const HISTORY_PAGE = 30;
/** A session's linked items answered at most. */
const LINKED_MAX = 50;
const CLOSED_LIMIT_DEFAULT = 50;
const CLOSED_LIMIT_MAX = 100;
const FETCH_PARALLEL = 6;
/** The picker lists at most this many repositories per installation (five pages). */
export const GRANTED_MAX = 500;
/** Durable Object SQL binds at most 100 parameters per statement. */
const BIND_MAX = 90;
/** Stored bodies re-parsed per step after PARSER_VERSION changes. */
export const REPARSE_BATCH = 100;
/** The tables' shape; another stored version drops them (the repository is the record). */
const SCHEMA_VERSION = 4;
/**
 * Bytes of an item file kept in `items.body`. Durable Object SQLite refuses a string or a row over
 * 2 MB; a larger file is kept cut (`body_note` 'cut'), and a row that cannot be written is kept
 * without its body ('unstored'), so one file never stops the build or an advance.
 */
export const BODY_STORE_BYTES = 1_000_000;
/** A commit touching more item files than this is a bulk edit: no item's own activity, no owner. */
export const BULK_ITEMS = 5;
/** An item whose own last change is this recent is active (with a session at work, in the Worker). */
export const RECENT_DAYS = 14;
const DAY_MS = 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  number INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  stage TEXT NOT NULL,
  blob TEXT NOT NULL,
  body TEXT NOT NULL,
  parsed TEXT NOT NULL,
  parser INTEGER NOT NULL,
  body_note TEXT,
  author_name TEXT, author_email TEXT, created_at TEXT,
  updated_at TEXT, closed_at TEXT, closed_by TEXT,
  updated_name TEXT, updated_email TEXT,
  activity_at TEXT, activity_name TEXT, activity_email TEXT
);
CREATE INDEX IF NOT EXISTS items_stage ON items (stage, number);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, number INTEGER NOT NULL, blob TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS files_number ON files (number);
CREATE TABLE IF NOT EXISTS links (number INTEGER NOT NULL, session_id TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY (number, session_id));
CREATE TABLE IF NOT EXISTS commits (
  sha TEXT PRIMARY KEY, at TEXT, author_name TEXT NOT NULL, author_email TEXT, message TEXT NOT NULL, detailed INTEGER NOT NULL,
  listed TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS commits_todo ON commits (detailed, at);
CREATE TABLE IF NOT EXISTS revisions (
  number INTEGER NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL, at TEXT NOT NULL, author_name TEXT NOT NULL, summary TEXT NOT NULL, session_id TEXT,
  PRIMARY KEY (number, sha, path)
);
CREATE INDEX IF NOT EXISTS revisions_order ON revisions (number, at, sha);
CREATE TABLE IF NOT EXISTS pulls (url TEXT PRIMARY KEY, state TEXT, title TEXT, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS failures (k TEXT PRIMARY KEY, tries INTEGER NOT NULL, retry_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;
const TABLES = ["items", "files", "links", "commits", "revisions", "pulls", "failures"];

/** What the index needs of where it runs. */
export interface WorkIndexDeps {
  store: IndexStore;
  clock: Clock;
  scheduler: Scheduler;
  /** The organization's Account object. */
  account(accountId: string): TokenMinter;
  fetch: Fetch;
}

/** The columns a list shows (no body). */
const ROW_COLUMNS =
  "number, path, stage, blob, parsed, parser, author_name, author_email, created_at, updated_at, closed_at, closed_by, updated_name, updated_email, activity_at, activity_name, activity_email";

interface ItemRow {
  number: number;
  path: string;
  stage: string;
  blob: string;
  parsed: string;
  parser: number;
  author_name: string | null;
  author_email: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  closed_by: string | null;
  /** The author of the latest commit that touched the file. */
  updated_name: string | null;
  updated_email: string | null;
  /** The latest commit that touched the file and was not a bulk edit, and its author. */
  activity_at: string | null;
  activity_name: string | null;
  activity_email: string | null;
}

type Row = Record<string, StoreValue>;
type Dir = "work" | "done";
const DIRS: Dir[] = ["work", "done"];

interface StoredRepo extends WorkRepo {}

/**
 * The walk's listing: one folder's commits from a build's `head` back to the first commit already
 * listed for that folder, or (`range`) an advance's commits `base...head` from compare.
 */
interface DirTask {
  kind?: "dir";
  dir: Dir;
  head: string;
  /** The next page to ask. */
  page: number;
}
type WalkTask = DirTask | { kind: "range"; base: string; head: string; page: number };

interface WalkState {
  tasks: WalkTask[];
}

type DirShas = Record<Dir, string | null>;

/** One organization's Work index. */
export class WorkIndex {
  private readonly store: IndexStore;
  private readonly clock: Clock;
  private github: WorkGitHub | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private looking: Promise<void> | null = null;
  private readonly filling = new Map<number, Promise<void>>();
  /** The picker's clients, one per installation, so a refresh reuses the token. */
  private readonly listers = new Map<string, WorkGitHub>();

  constructor(private readonly deps: WorkIndexDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.store.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    if (this.meta("schema_version") !== String(SCHEMA_VERSION)) {
      // An earlier shape: drop the projection and keep the setting; the next look rebuilds it.
      this.store.transaction(() => {
        for (const table of TABLES) this.store.exec(`DROP TABLE IF EXISTS ${table}`);
        this.store.exec("DELETE FROM meta WHERE k NOT IN ('repo', 'account_id')");
        this.setMeta("schema_version", SCHEMA_VERSION);
        this.setMeta("parser_version", PARSER_VERSION);
      });
    }
    this.store.exec(SCHEMA);
  }

  private now(): number {
    return this.clock.now();
  }

  // ------------------------------------------------------------------ meta

  private meta(k: string): string | null {
    const row = this.store.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0];
    return row ? row.v : null;
  }

  private setMeta(k: string, v: string | number | null): void {
    if (v === null) this.store.exec("DELETE FROM meta WHERE k = ?", k);
    else this.store.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, String(v));
  }

  private metaJson<T>(k: string): T | null {
    const v = this.meta(k);
    if (v === null) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  private metaNumber(k: string): number {
    const v = Number(this.meta(k));
    return Number.isFinite(v) ? v : 0;
  }

  /** Marks the projection changed: the open list's ETag moves. Call inside the writing transaction. */
  private bump(): void {
    this.setMeta("version", this.metaNumber("version") + 1);
  }

  /** The organization the object serves; recorded on the first call so the alarm knows it. */
  private bind(accountId: string): void {
    if (this.meta("account_id") !== accountId) this.setMeta("account_id", accountId);
  }

  private repo(): StoredRepo | null {
    return this.metaJson<StoredRepo>("repo");
  }

  private newClient(repo: WorkRepo, accountId: string): WorkGitHub {
    return new WorkGitHub({ repo, account: this.deps.account(accountId), clock: this.clock, fetch: this.deps.fetch });
  }

  private client(): WorkGitHub | null {
    const repo = this.repo();
    const accountId = this.meta("account_id");
    if (!repo || !accountId) return null;
    const g = this.github;
    if (g && g.repo.installationId === repo.installationId && g.repo.owner === repo.owner && g.repo.name === repo.name && g.repo.branch === repo.branch) return g;
    this.github = this.newClient(repo, accountId);
    return this.github;
  }

  private problemNow(): { problem: RepositoryProblem | null; problemMessage: string | null } {
    return { problem: (this.meta("problem") as RepositoryProblem | null) ?? null, problemMessage: this.meta("problem_message") };
  }

  private repository(): Repository | null {
    const repo = this.repo();
    if (!repo) return null;
    return { installationId: repo.installationId, owner: repo.owner, name: repo.name, branch: repo.branch, ...this.problemNow() };
  }

  private readState(): ReadState {
    const asOf = this.metaNumber("as_of");
    const build = this.metaJson<{ head: string }>("build");
    return {
      head: this.meta("cursor") ?? build?.head ?? null,
      asOf: asOf ? new Date(asOf).toISOString() : null,
      building: build !== null,
      version: this.metaNumber("version"),
      ...this.problemNow(),
    };
  }

  /** Until when GitHub asked us to wait (core requests), from storage: it outlives the client. */
  private pausedUntil(): number {
    const until = this.metaNumber("pause_until");
    return until > this.now() ? until : 0;
  }

  // ------------------------------------------------------------------ one at a time

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Looks once, joining a look already queued. */
  private kick(): Promise<void> {
    if (!this.looking) {
      this.looking = this.exclusive(() => this.look()).finally(() => {
        this.looking = null;
      });
    }
    return this.looking;
  }

  /** A read: note it, and look behind the response when the head is older than 10 s. */
  private noteRead(): void {
    const now = this.now();
    this.setMeta("read_at", now);
    if (!this.repo()) return;
    const seen = Math.max(this.metaNumber("as_of"), this.metaNumber("tried_at"));
    if (now - seen > LOOK_AFTER_MS || this.reparsing()) this.deps.scheduler.waitUntil(this.kick());
    this.deps.scheduler.waitUntil(this.deps.scheduler.arm(now + ALARM_EVERY_MS));
  }

  // ------------------------------------------------------------------ RPC

  async getRepository(accountId: string): Promise<Repository | null> {
    this.bind(accountId);
    return this.repository();
  }

  async poke(accountId: string): Promise<void> {
    this.bind(accountId);
    if (!this.repo()) return;
    this.deps.scheduler.waitUntil(this.kick());
  }

  /** The open list's stamp, for its ETag: SQL only. A read like the others (it may look behind). */
  async stamp(accountId: string): Promise<OpenStamp> {
    this.bind(accountId);
    this.noteRead();
    const { head, asOf, version } = this.readState();
    const recent = this.store.exec<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE stage = 'open' AND activity_at >= ?", this.recentSince())[0]!.n;
    return { head, asOf, version, recent };
  }

  /** The commits' time format (no milliseconds) RECENT_DAYS ago: a change at or after it is recent. */
  private recentSince(): string {
    return new Date(this.now() - RECENT_DAYS * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /**
   * Checks the choice against GitHub with a fresh client (a stored problem or pause plays no part),
   * then stores it. The owner must be the installation's account.
   */
  async setRepository(accountId: string, choice: RepositoryChoice, _by: WorkActor): Promise<WorkWrite<Repository>> {
    this.bind(accountId);
    return this.exclusive(async () => {
      const trial = this.newClient({ installationId: choice.installationId, owner: choice.owner, name: choice.name, branch: choice.branch ?? "main" }, accountId);
      let repo: StoredRepo;
      try {
        const login = await trial.accountLogin();
        if (login.toLowerCase() !== choice.owner.toLowerCase()) {
          return { ok: false, status: 400, code: "invalid_request", message: `The installation is on the GitHub account ${login}; owner must be ${login}.`, field: "owner", reason: "owner_mismatch" };
        }
        const found = await trial.repository();
        repo = { installationId: choice.installationId, owner: found.owner, name: found.name, branch: choice.branch ?? found.defaultBranch, ...(found.id !== null ? { id: found.id } : {}) };
        await this.newClient(repo, accountId).head();
      } catch (error) {
        if (error instanceof GitHubGone) {
          const field = error.problem === "branch_not_found" ? "branch" : error.problem === "repository_not_found" ? "name" : "installationId";
          return { ok: false, status: 400, code: "invalid_request", message: error.message, field, reason: error.problem };
        }
        const retryAfterMs = error instanceof GitHubPaused ? Math.max(1000, error.until - this.now()) : 5_000;
        return { ok: false, status: 503, code: "unavailable", message: "GitHub could not be reached. Try again shortly.", retryAfterMs };
      }
      const current = this.repo();
      const same =
        current !== null &&
        current.installationId === repo.installationId &&
        current.branch === repo.branch &&
        (current.id !== undefined && repo.id !== undefined
          ? current.id === repo.id
          : current.owner.toLowerCase() === repo.owner.toLowerCase() && current.name.toLowerCase() === repo.name.toLowerCase());
      this.store.transaction(() => {
        if (!same) {
          for (const table of TABLES) this.store.exec(`DELETE FROM ${table}`);
          for (const k of ["cursor", "build", "walk", "dirs", "head_etag", "as_of", "tried_at", "pulls_at", "pause_until", "pulls_pause_until", "stall"]) this.setMeta(k, null);
        }
        this.setMeta("repo", JSON.stringify(repo));
        this.clearProblem();
        this.bump();
      });
      this.github = null;
      this.deps.scheduler.waitUntil(this.kick());
      return { ok: true, value: this.repository()! };
    });
  }

  /**
   * The organization's active installations, each with the repositories it grants, read from
   * GitHub on every call: the picker asks again when the person comes back from granting access.
   * An installation GitHub will not list carries its problem; any other failure answers unavailable.
   */
  async repositories(accountId: string): Promise<RepositoriesResult> {
    this.bind(accountId);
    const account = this.deps.account(accountId);
    const active = (await account.listGitHubInstallations()).filter((i) => i.state === "active");
    try {
      const installations = await Promise.all(
        active.map(async (i): Promise<GrantingInstallation> => {
          const organization = i.accountType.toLowerCase() === "organization";
          const shown = {
            id: String(i.id),
            accountLogin: i.accountLogin,
            accountType: organization ? "Organization" : "User",
            settingsUrl: organization
              ? `https://github.com/organizations/${encodeURIComponent(i.accountLogin)}/settings/installations/${i.githubInstallationId}`
              : `https://github.com/settings/installations/${i.githubInstallationId}`,
          };
          let lister = this.listers.get(shown.id);
          if (!lister) {
            // A client for the installation alone: listing reads no repository.
            lister = this.newClient({ installationId: shown.id, owner: i.accountLogin, name: "", branch: "" }, accountId);
            this.listers.set(shown.id, lister);
          }
          try {
            const { repositories, truncated } = await lister.grantedRepositories(GRANTED_MAX);
            return { ...shown, repositories: repositories.sort(byPushed), truncated, problem: null, problemMessage: null };
          } catch (error) {
            if (!(error instanceof GitHubGone)) throw error;
            return { ...shown, repositories: [], truncated: false, problem: error.problem, problemMessage: error.message };
          }
        }),
      );
      return { ok: true, installations };
    } catch (error) {
      const retryAfterMs = error instanceof GitHubPaused ? Math.max(1000, error.until - this.now()) : 5_000;
      return { ok: false, error: "unavailable", retryAfterMs };
    }
  }

  async items(accountId: string, query: ItemsQuery): Promise<ItemsResult> {
    this.bind(accountId);
    this.noteRead();
    const repository = this.repository();
    if (query.stage === "open") {
      const rows = this.store.exec<ItemRow & Row>(`SELECT ${ROW_COLUMNS} FROM items WHERE stage = 'open' ORDER BY number`);
      return { ok: true, ...this.readState(), repository, items: this.indexed(rows), nextCursor: null };
    }
    let before = Number.MAX_SAFE_INTEGER;
    if (query.cursor !== undefined) {
      const n = decodeCursor(query.cursor)?.n;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return { ok: false, error: "invalid_cursor" };
      before = n;
    }
    const limit = Math.min(Math.max(query.limit ?? CLOSED_LIMIT_DEFAULT, 1), CLOSED_LIMIT_MAX);
    const select = () => this.store.exec<ItemRow & Row>(`SELECT ${ROW_COLUMNS} FROM items WHERE stage = 'closed' AND number < ? ORDER BY number DESC LIMIT ?`, before, limit + 1);
    let rows = select();
    const pending = rows.slice(0, limit).filter((r) => r.parser === 0);
    // Bodies not read yet are read now, for at most READ_WAIT_MS; the page then shows what it has.
    if (pending.length) {
      await within(this.clock, READ_WAIT_MS, this.fillLater(pending).then(() => true), () => false);
      rows = select();
    }
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor({ n: page[page.length - 1]!.number }) : null;
    return { ok: true, ...this.readState(), repository, items: this.indexed(page), nextCursor };
  }

  async item(accountId: string, number: number): Promise<ItemResult> {
    this.bind(accountId);
    this.noteRead();
    const select = () => this.store.exec<ItemRow & { body: string } & Row>(`SELECT ${ROW_COLUMNS}, body FROM items WHERE number = ?`, number)[0];
    let row = select();
    if (row && row.parser === 0) {
      // Read now, within READ_WAIT_MS; else the caller is told to come back.
      await within(this.clock, READ_WAIT_MS, this.fillLater([row]), () => undefined);
      row = select();
      if (row && row.parser === 0) return { ok: false, error: "unavailable", retryAfterMs: Math.max(1000, this.pausedUntil() - this.now(), 5_000) };
    }
    return { ok: true, ...this.readState(), repository: this.repository(), item: row ? this.indexed([row])[0]! : null, body: row ? row.body : null };
  }

  /**
   * The items linked to a session: their commits carry one of `refs` in a `Session:` trailer. Open
   * and closed, by number; at most LINKED_MAX. Bodies not read yet show their slug.
   */
  async linked(accountId: string, refs: string[]): Promise<LinkedResult> {
    this.bind(accountId);
    this.noteRead();
    const wanted = [...new Set(refs.filter((r) => typeof r === "string" && r.length > 0 && r.length <= 128))].slice(0, BIND_MAX);
    const numbers = wanted.length
      ? this.store.exec<{ number: number } & Row>(`SELECT DISTINCT number FROM links WHERE session_id IN (${marks(wanted)}) ORDER BY number LIMIT ?`, ...wanted, LINKED_MAX).map((r) => r.number)
      : [];
    const rows = numbers.length ? this.store.exec<ItemRow & Row>(`SELECT ${ROW_COLUMNS} FROM items WHERE number IN (${marks(numbers)}) ORDER BY number`, ...numbers) : [];
    return { ok: true, ...this.readState(), repository: this.repository(), items: this.indexed(rows) };
  }

  /**
   * An item's revisions, newest first, across every path it has had. From the walk's revisions
   * when the walk is done; until then those and GitHub's commits of each path, within READ_WAIT_MS.
   */
  async history(accountId: string, number: number, cursor?: string): Promise<HistoryResult> {
    this.bind(accountId);
    this.noteRead();
    const row = this.store.exec<{ path: string }>("SELECT path FROM items WHERE number = ?", number)[0];
    if (!row) return { ok: false, error: "item_not_found" };
    let after: { at: string; sha: string } | null = null;
    if (cursor !== undefined) {
      const c = decodeCursor(cursor);
      if (!c || typeof c.a !== "string" || typeof c.s !== "string" || !/^[0-9a-f]{40}$/.test(c.s)) return { ok: false, error: "invalid_cursor" };
      after = { at: c.a, sha: c.s };
    }
    const repo = this.repo()!;
    const stored = this.store.exec<{ sha: string; at: string; author_name: string; summary: string; session_id: string | null } & Row>(
      `SELECT sha, at, MIN(author_name) AS author_name, MIN(summary) AS summary, MIN(session_id) AS session_id FROM revisions
       WHERE number = ? ${after ? "AND (at < ? OR (at = ? AND sha < ?))" : ""} GROUP BY sha, at ORDER BY at DESC, sha DESC LIMIT ?`,
      number,
      ...(after ? [after.at, after.at, after.sha] : []),
      HISTORY_PAGE + 1,
    );
    const found = new Map<string, Revision>();
    for (const r of stored) found.set(r.sha, { sha: r.sha, url: commitUrl(repo, r.sha), at: r.at, authorName: r.author_name, summary: r.summary, sessionId: r.session_id });
    let more = stored.length > HISTORY_PAGE;

    if (!this.walkDone()) {
      const gh = this.client();
      const head = this.readState().head;
      if (!gh || !head || this.pausedUntil()) return { ok: false, error: "unavailable", retryAfterMs: Math.max(1000, this.pausedUntil() - this.now(), 5_000) };
      const paths = this.pathsOf(number, row.path);
      const fetched = within(
        this.clock,
        READ_WAIT_MS,
        Promise.all(paths.map((path) => gh.commits({ sha: head, path, page: 1, perPage: HISTORY_PAGE + 1, ...(after ? { until: after.at } : {}) }))).then((lists) => lists as CommitInfo[][] | null),
        () => null,
      ).catch((error: unknown) => {
        if (error instanceof GitHubGone || error instanceof GitHubPaused || error instanceof GitHubUnavailable) return null;
        throw error;
      });
      const lists = await fetched;
      if (!lists) return { ok: false, error: "unavailable", retryAfterMs: Math.max(1000, this.pausedUntil() - this.now(), 5_000) };
      for (const list of lists) {
        if (list.length > HISTORY_PAGE) more = true;
        for (const c of list) {
          const at = c.at ?? "";
          if (after && !(at < after.at || (at === after.at && c.sha < after.sha))) continue;
          if (found.has(c.sha)) continue;
          const trailers = sessionTrailers(c.message);
          found.set(c.sha, { sha: c.sha, url: commitUrl(repo, c.sha), at, authorName: c.authorName, summary: summaryOf(c.message), sessionId: trailers[0] ?? null });
        }
      }
    }
    const all = [...found.values()].sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.sha < b.sha ? 1 : -1));
    const revisions = all.slice(0, HISTORY_PAGE);
    if (all.length > HISTORY_PAGE) more = true;
    const last = revisions[revisions.length - 1];
    return { ok: true, ...this.readState(), revisions, nextCursor: more && last ? encodeCursor({ a: last.at, s: last.sha }) : null };
  }

  /** Every path the item has had: its files now, the paths of its revisions, its name in both folders. */
  private pathsOf(number: number, path: string): string[] {
    const paths = new Set<string>();
    for (const r of this.store.exec<{ path: string }>("SELECT path FROM files WHERE number = ? UNION SELECT path FROM revisions WHERE number = ?", number, number)) paths.add(r.path);
    const file = path.slice(path.indexOf("/") + 1);
    for (const dir of DIRS) paths.add(`${dir}/${file}`);
    return [...paths].sort();
  }

  /** The alarm: continue a build, look while there are readers or a problem is due, walk. Returns when to come back. */
  async alarm(): Promise<number | null> {
    if (!this.repo() || this.meta("problem_final") !== null) return null;
    const version = this.metaNumber("version");
    await this.exclusive(async () => {
      const now = this.now();
      this.reparseBatch();
      if (this.meta("problem") !== null) {
        await this.look();
        return;
      }
      if (this.meta("build") !== null) {
        if (now - this.metaNumber("as_of") >= ALARM_EVERY_MS) await this.look();
        else await this.guard(() => this.fillOpen());
        return;
      }
      // No cursor and no build: the first build failed (GitHub down, or no spare quota). Again.
      if (this.meta("cursor") === null || now - this.metaNumber("read_at") < READS_WINDOW_MS) await this.look();
      else await this.guard(() => this.walkStep(WALK_PAGES_PER_TICK, WALK_DETAILS_PER_TICK));
    });
    const now = this.now();
    const starting = this.meta("build") !== null || this.meta("cursor") === null;
    if (starting) this.setMeta("stall", this.metaNumber("version") !== version ? 0 : this.metaNumber("stall") + 1);
    let next: number | null = null;
    if (this.meta("problem") !== null) next = Math.max(this.metaNumber("problem_retry_at"), now + BUILD_STEP_MS);
    else if (starting) next = this.startNext();
    else if (this.reparsing()) next = now + BUILD_STEP_MS;
    else if (now - this.metaNumber("read_at") < READS_WINDOW_MS || !this.walkDone()) next = now + ALARM_EVERY_MS;
    if (next !== null && this.pausedUntil() > next) next = this.pausedUntil();
    return next;
  }

  /**
   * When to come back to a build (or a first build that failed): a step on, later after each alarm
   * that moved nothing (to PROBLEM_RETRY_MAX_MS), never after a waiting blob is due.
   */
  private startNext(): number {
    const now = this.now();
    const building = this.meta("build") !== null;
    const step = building ? BUILD_STEP_MS : PROBLEM_RETRY_MS;
    let next = now + Math.min(step * 2 ** Math.min(this.metaNumber("stall"), 30), PROBLEM_RETRY_MAX_MS);
    if (building) {
      const due = this.store.exec<{ at: number | null }>(
        "SELECT MIN(f.retry_at) AS at FROM items i JOIN failures f ON f.k = 'blob:' || i.blob WHERE i.parser = 0 AND i.stage = 'open'",
      )[0]?.at;
      if (typeof due === "number") next = Math.min(next, due);
      if (this.reparsing()) next = Math.min(next, now + BUILD_STEP_MS);
    }
    return Math.max(next, now + BUILD_STEP_MS);
  }

  // ------------------------------------------------------------------ failures of one blob or commit

  /** Notes a failure of `key`; true when it has now failed FAILURE_TRIES times (give it up). */
  private failed(key: string): boolean {
    const tries = (this.store.exec<{ tries: number }>("SELECT tries FROM failures WHERE k = ?", key)[0]?.tries ?? 0) + 1;
    const retryAt = this.now() + Math.min(FAILURE_RETRY_MS * 2 ** (tries - 1), PROBLEM_RETRY_MAX_MS);
    this.store.exec("INSERT INTO failures (k, tries, retry_at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET tries = excluded.tries, retry_at = excluded.retry_at", key, tries, retryAt);
    return tries >= FAILURE_TRIES;
  }

  // ------------------------------------------------------------------ looking

  /**
   * Runs `fn` with GitHub failures recorded: a pause until it ends (per resource), a permanent
   * failure as the problem. A repository that is not found is looked for by its id first: renamed,
   * it is followed and the next look carries on.
   */
  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (error instanceof GitHubGone) {
        if (error.problem === "repository_not_found" && (await this.relocate())) return;
        this.setProblem(error.problem, error.message, error.problem === "installation_removed" && (await this.installationGone()));
      } else if (error instanceof GitHubPaused) {
        this.setMeta(error.resource === "graphql" ? "pulls_pause_until" : "pause_until", error.until);
      } else if (!(error instanceof GitHubUnavailable)) throw error;
    }
  }

  /** `final`: retrying from the alarm cannot help (the installation is gone); reads still look. */
  private setProblem(problem: RepositoryProblem, message: string, final = false): void {
    const tries = this.meta("problem") !== null ? this.metaNumber("problem_tries") + 1 : 0;
    this.store.transaction(() => {
      if (this.meta("problem") !== problem || this.meta("problem_message") !== message) this.bump();
      this.setMeta("problem", problem);
      this.setMeta("problem_message", message);
      this.setMeta("problem_tries", tries);
      this.setMeta("problem_retry_at", this.now() + Math.min(PROBLEM_RETRY_MS * 2 ** tries, PROBLEM_RETRY_MAX_MS));
      this.setMeta("problem_final", final ? 1 : null);
    });
  }

  /** Whether the Account object confirms the stored installation is gone: it no longer has it. A failure to ask is not a yes. */
  private async installationGone(): Promise<boolean> {
    const repo = this.repo();
    const accountId = this.meta("account_id");
    if (!repo || !accountId) return false;
    try {
      return (await this.deps.account(accountId).getGitHubInstallation(repo.installationId)) === null;
    } catch {
      return false;
    }
  }

  private clearProblem(): void {
    if (this.meta("problem") === null) return;
    for (const k of ["problem", "problem_message", "problem_tries", "problem_retry_at", "problem_final"]) this.setMeta(k, null);
    this.bump();
  }

  /** The stored repository not found by name: found by id under another name, it is stored and true. */
  private async relocate(): Promise<boolean> {
    const repo = this.repo();
    const gh = this.client();
    if (!repo?.id || !gh) return false;
    try {
      const found = await gh.locate(repo.id);
      if (!found || (found.owner === repo.owner && found.name === repo.name)) return false;
      this.follow(repo, found);
      return true;
    } catch {
      return false;
    }
  }

  /** The repository is now called `found`: store it; the projection stays (it is the same repository). */
  private follow(repo: StoredRepo, found: { owner: string; name: string }): void {
    this.store.transaction(() => {
      this.setMeta("repo", JSON.stringify({ ...repo, owner: found.owner, name: found.name }));
      this.bump();
    });
    this.github = null;
  }

  /** Checks the head and moves the projection to it; then one step of background work. */
  private async look(): Promise<void> {
    this.reparseBatch();
    const gh = this.client();
    if (!gh) return;
    if (this.pausedUntil()) return;
    if (this.meta("problem") !== null && this.metaNumber("problem_retry_at") > this.now()) return;
    this.setMeta("tried_at", this.now());
    await this.guard(async () => {
      const etag = this.meta("head_etag") ?? undefined;
      const head = await gh.head(etag);
      this.store.transaction(() => this.clearProblem());
      if (gh.moved) {
        const found = await gh.repository();
        if (found.owner !== gh.repo.owner || found.name !== gh.repo.name) this.follow(this.repo()!, found);
        gh.moved = false;
      }
      // One piece of GitHub work per look: a build or an advance, else a batch of the build, else a step of the walk.
      let moved = false;
      if (head !== "unchanged") {
        // Background work spends the organization's shared quota only when there is spare.
        if (!gh.spare()) return;
        const cursor = this.meta("cursor");
        if (this.meta("build") !== null) {
          // A build in progress finishes at its head; the next look advances from there.
        } else if (cursor === null) {
          await this.build(gh, head.sha);
          moved = true;
        } else if (cursor !== head.sha) {
          if ((await this.advance(gh, cursor, head.sha)) === "rebuild") await this.build(gh, head.sha);
          moved = true;
        }
        if (this.meta("cursor") === head.sha && head.etag) this.setMeta("head_etag", head.etag);
      }
      this.setMeta("as_of", this.now());
      if (this.meta("build") !== null) {
        await this.fillOpen();
        if (this.meta("build") !== null) this.deps.scheduler.waitUntil(this.deps.scheduler.arm(this.startNext()));
      } else if (!moved && !this.walkDone()) {
        await this.walkStep(1, WALK_DETAILS_PER_TICK);
      }
    });
    await this.guard(async () => {
      const g = this.client();
      if (g && this.meta("problem") === null) await this.refreshPulls(g);
    });
  }

  // ------------------------------------------------------------------ build

  /** Lists `work/` and `done/` at `head`; open items are read by `fillOpen`, closed ones on demand. */
  private async build(gh: WorkGitHub, head: string): Promise<void> {
    const root = await gh.tree(head);
    if (!root) throw new GitHubUnavailable(`GitHub has no tree for ${head}.`);
    const listing = new Map<string, { number: number; blob: string }>();
    const dirs: DirShas = { work: null, done: null };
    for (const dir of DIRS) {
      const entry = root.entries.find((e) => e.name === dir && e.type === "tree");
      if (!entry) continue;
      dirs[dir] = entry.sha;
      for (const [path, f] of await this.listDir(gh, dir, entry.sha)) listing.set(path, f);
    }
    const winners = pickWinners([...listing].map(([path, f]) => ({ path, ...f })));
    const store = this.store;
    this.store.transaction(() => {
      store.exec("DELETE FROM files");
      for (const [path, f] of listing) store.exec("INSERT INTO files (path, number, blob) VALUES (?, ?, ?)", path, f.number, f.blob);
      // The history may have been rewritten: what the walk learnt is learnt again from the new one.
      // Links (the sessions that worked on an item) stay.
      store.exec("DELETE FROM commits");
      store.exec("DELETE FROM revisions");
      store.exec("DELETE FROM failures");
      const old = new Map(
        store.exec<{ number: number; path: string; blob: string; body: string; body_note: string | null; parser: number } & Row>("SELECT number, path, blob, body, body_note, parser FROM items").map((r) => [r.number, r]),
      );
      for (const [number] of old) {
        if (!winners.has(number)) {
          store.exec("DELETE FROM items WHERE number = ?", number);
          store.exec("DELETE FROM links WHERE number = ?", number);
        }
      }
      for (const [number, w] of winners) {
        const ip = itemPath(w.path)!;
        const prev = old.get(number);
        const keep = prev && prev.blob === w.blob && prev.parser > 0;
        store.exec(
          `INSERT INTO items (number, path, stage, blob, body, body_note, parsed, parser) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (number) DO UPDATE SET path = excluded.path, stage = excluded.stage, blob = excluded.blob, body = excluded.body, body_note = excluded.body_note, parsed = excluded.parsed,
             parser = excluded.parser, author_name = NULL, author_email = NULL, created_at = NULL, updated_at = NULL, closed_at = NULL, closed_by = NULL,
             updated_name = NULL, updated_email = NULL, activity_at = NULL, activity_name = NULL, activity_email = NULL`,
          number,
          w.path,
          ip.stage,
          w.blob,
          keep ? prev.body : "",
          keep ? prev.body_note : null,
          JSON.stringify(keep ? safeParse(ip, prev.body, prev.body_note) : pendingParse(ip)),
          keep ? PARSER_VERSION : 0,
        );
      }
      for (const k of ["cursor", "head_etag", "walk", "dirs"]) this.setMeta(k, null);
      this.setMeta("build", JSON.stringify({ head, dirs }));
      this.bump();
    });
  }

  /** A folder's item files: path to number and blob. */
  private async listDir(gh: WorkGitHub, dir: Dir, sha: string): Promise<Map<string, { number: number; blob: string }>> {
    const out = new Map<string, { number: number; blob: string }>();
    const tree = await gh.tree(sha);
    if (!tree) throw new GitHubUnavailable(`GitHub has no tree ${sha}.`);
    for (const e of tree.entries) {
      const path = `${dir}/${e.name}`;
      const ip = e.type === "blob" ? itemPath(path) : null;
      if (ip) out.set(path, { number: ip.number, blob: e.sha });
    }
    return out;
  }

  /** One batch of open items not read yet; the cursor is set when none is left, and the walk starts. */
  private async fillOpen(): Promise<void> {
    const build = this.metaJson<{ head: string; dirs: DirShas }>("build");
    const gh = this.client();
    if (!build || !gh || !gh.spare()) return;
    // Not the blobs that failed and are not due again: they wait their backoff, the others go on.
    const rows = this.store.exec<ItemRow & Row>(
      `SELECT ${ROW_COLUMNS} FROM items WHERE parser = 0 AND stage = 'open'
       AND NOT EXISTS (SELECT 1 FROM failures f WHERE f.k = 'blob:' || items.blob AND f.retry_at > ?) ORDER BY number LIMIT ?`,
      this.now(),
      FILL_BATCH,
    );
    let failure: unknown = null;
    await parallel(rows, (row) =>
      this.fill(gh, row).catch((error: unknown) => {
        failure ??= error;
      }),
    );
    if (failure !== null && !(failure instanceof GitHubUnavailable)) throw failure;
    const left = this.store.exec<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE parser = 0 AND stage = 'open'")[0]!.n;
    if (left > 0) return;
    this.store.transaction(() => {
      this.setMeta("cursor", build.head);
      this.setMeta("dirs", JSON.stringify(build.dirs));
      this.setMeta("build", null);
      this.setMeta("walk", JSON.stringify({ tasks: DIRS.map((dir) => ({ dir, head: build.head, page: 1 })) } satisfies WalkState));
      this.bump();
    });
  }

  /** Reads one row's body; written only if the row still has that blob. */
  private async fill(gh: WorkGitHub, row: { number: number; path: string; blob: string }): Promise<void> {
    const ip = itemPath(row.path);
    if (!ip) return;
    let text: string | null = null;
    try {
      text = await gh.blob(row.blob);
    } catch (error) {
      if (!(error instanceof GitHubUnavailable)) throw error;
      // Asked again after a backoff; after FAILURE_TRIES, the row is kept with its name and a warning.
      if (!this.failed(`blob:${row.blob}`)) throw error;
      console.warn(`Work index: blob ${row.blob} of ${row.path} could not be read after ${FAILURE_TRIES} tries: ${error.message}`);
    }
    const kept = text === null ? UNREAD : keepBody(text);
    const write = (k: KeptBody) =>
      this.store.transaction(() => {
        this.store.exec(
          "UPDATE items SET body = ?, body_note = ?, parsed = ?, parser = ? WHERE number = ? AND blob = ? AND path = ?",
          k.body,
          k.note,
          JSON.stringify(safeParse(ip, k.body, k.note)),
          PARSER_VERSION,
          row.number,
          row.blob,
          row.path,
        );
        this.store.exec("DELETE FROM failures WHERE k = ?", `blob:${row.blob}`);
        this.bump();
      });
    try {
      write(kept);
    } catch {
      // The row's problem, not the build's: kept without its body, with a warning.
      write(UNSTORED);
    }
  }

  /** Bodies asked for before they were read: read them (joining a read already running), within the quota. */
  private fillLater(rows: { number: number; path: string; blob: string }[]): Promise<void> {
    const gh = this.client();
    if (!gh || this.pausedUntil() || !gh.spare()) return Promise.resolve();
    const reads: Promise<void>[] = [];
    const todo: typeof rows = [];
    for (const r of rows) {
      const running = this.filling.get(r.number);
      if (running) reads.push(running);
      else todo.push(r);
    }
    if (todo.length) {
      const work = parallel(todo, (row) => this.guard(() => this.fill(gh, row)));
      const done = work.finally(() => {
        for (const r of todo) this.filling.delete(r.number);
      });
      for (const r of todo) this.filling.set(r.number, done);
      this.deps.scheduler.waitUntil(done);
      reads.push(done);
    }
    return Promise.all(reads).then(() => undefined);
  }

  // ------------------------------------------------------------------ advance

  /**
   * From the cursor `base` to `head`: compare for ancestry (and its files when complete), else the
   * folder trees; the changed blobs; one transaction. "rebuild" only when the head is not ahead.
   */
  async advance(gh: WorkGitHub, base: string, head: string): Promise<"done" | "rebuild"> {
    const cmp = await gh.compare(base, head);
    if (!cmp || (cmp.status !== "ahead" && cmp.status !== "identical")) return "rebuild";

    // The item files that changed: path to its blob at the head, or null when it is gone.
    const changes = new Map<string, string | null>();
    const touchedDirs = new Set<Dir>();
    let dirsNow: DirShas | null = null;
    if (cmp.files.length < COMPARE_FILES_MAX) {
      for (const f of cmp.files) {
        for (const p of [f.filename, f.previousFilename]) {
          const dir = p ? dirOf(p) : null;
          if (dir) touchedDirs.add(dir);
        }
        if (f.status === "renamed" && f.previousFilename && itemPath(f.previousFilename)) changes.set(f.previousFilename, null);
        if (itemPath(f.filename)) changes.set(f.filename, f.status === "removed" ? null : f.sha);
      }
    } else {
      // Compare's file list may be cut: the folders' trees, only those whose sha moved.
      const root = await gh.tree(head);
      if (!root) throw new GitHubUnavailable(`GitHub has no tree for ${head}.`);
      const stored = this.metaJson<DirShas>("dirs");
      dirsNow = { work: null, done: null };
      for (const dir of DIRS) {
        const entry = root.entries.find((e) => e.name === dir && e.type === "tree");
        dirsNow[dir] = entry?.sha ?? null;
        if (stored && stored[dir] === dirsNow[dir]) continue;
        touchedDirs.add(dir);
        const now = entry ? await this.listDir(gh, dir, entry.sha) : new Map<string, { number: number; blob: string }>();
        const before = new Map(this.store.exec<{ path: string; blob: string } & Row>("SELECT path, blob FROM files WHERE path LIKE ?", `${dir}/%`).map((r) => [r.path, r.blob]));
        for (const path of before.keys()) if (!now.has(path)) changes.set(path, null);
        for (const [path, f] of now) if (before.get(path) !== f.blob) changes.set(path, f.blob);
      }
    }

    // The files of the affected numbers after the range, and the row each number gets.
    const numbers = new Set<number>();
    for (const path of changes.keys()) numbers.add(itemPath(path)!.number);
    const files = new Map<string, { number: number; blob: string }>();
    for (const part of chunks([...numbers])) {
      for (const r of this.store.exec<{ path: string; number: number; blob: string } & Row>(`SELECT path, number, blob FROM files WHERE number IN (${marks(part)})`, ...part)) {
        files.set(r.path, { number: r.number, blob: r.blob });
      }
    }
    for (const [path, blob] of changes) {
      if (blob === null) files.delete(path);
      else files.set(path, { number: itemPath(path)!.number, blob });
    }
    const winners = pickWinners([...files].map(([path, f]) => ({ path, ...f })));
    type OldRow = { number: number; path: string; stage: string; blob: string; body: string; body_note: string | null; parser: number } & Row;
    const old = new Map<number, OldRow>();
    for (const part of chunks([...numbers])) {
      for (const r of this.store.exec<OldRow>(
        `SELECT number, path, stage, blob, body, body_note, parser FROM items WHERE number IN (${marks(part)})`,
        ...part,
      )) {
        old.set(r.number, r);
      }
    }

    // Bodies to read, before the transaction: open items now, closed ones only when few.
    const needed = [...winners.values()].filter((w) => {
      const prev = old.get(w.number);
      return !prev || prev.blob !== w.blob || prev.parser === 0;
    });
    const readNow = needed.filter((w) => stageOf(w.path) === "open" || needed.length <= FILL_BATCH);
    const bodies = new Map<string, KeptBody>();
    await parallel(readNow, async (w) => {
      try {
        bodies.set(w.blob, keepBody(await gh.blob(w.blob)));
      } catch (error) {
        // A blob that never reads stops the advance FAILURE_TRIES times at most, then is kept unread.
        if (!(error instanceof GitHubUnavailable) || !this.failed(`blob:${w.blob}`)) throw error;
        console.warn(`Work index: blob ${w.blob} of ${w.path} could not be read after ${FAILURE_TRIES} tries: ${error.message}`);
        bodies.set(w.blob, UNREAD);
      }
    });

    // A range of one commit with every file listed: its details are compare's.
    const only = cmp.totalCommits === 1 && cmp.commits.length === 1 && cmp.files.length < COMPARE_FILES_MAX ? cmp.commits[0]! : null;

    const store = this.store;
    this.store.transaction(() => {
      for (const [path, blob] of changes) {
        if (blob === null) store.exec("DELETE FROM files WHERE path = ?", path);
        else store.exec("INSERT INTO files (path, number, blob) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET number = excluded.number, blob = excluded.blob", path, itemPath(path)!.number, blob);
      }
      for (const n of numbers) {
        const w = winners.get(n);
        const prev = old.get(n);
        if (!w) {
          store.exec("DELETE FROM items WHERE number = ?", n);
          store.exec("DELETE FROM links WHERE number = ?", n);
          continue;
        }
        const ip = itemPath(w.path)!;
        const kept: KeptBody | null = bodies.get(w.blob) ?? (prev && prev.blob === w.blob && prev.parser > 0 ? { body: prev.body, note: keptNote(prev.body_note) } : null);
        const changed = !prev || prev.blob !== w.blob || prev.path !== w.path;
        const moved = !prev || prev.stage !== ip.stage;
        // What changed is not dated yet; the walk dates it from the commit that did it.
        const write = (k: KeptBody | null) =>
          store.exec(
            `INSERT INTO items (number, path, stage, blob, body, body_note, parsed, parser) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (number) DO UPDATE SET path = excluded.path, stage = excluded.stage, blob = excluded.blob, body = excluded.body,
               body_note = excluded.body_note, parsed = excluded.parsed, parser = excluded.parser,
               updated_at = CASE WHEN ? THEN NULL ELSE updated_at END,
               closed_at = CASE WHEN ? THEN NULL ELSE closed_at END,
               closed_by = CASE WHEN ? THEN NULL ELSE closed_by END`,
            n,
            w.path,
            ip.stage,
            w.blob,
            k?.body ?? "",
            k?.note ?? null,
            JSON.stringify(k ? safeParse(ip, k.body, k.note) : pendingParse(ip)),
            k ? PARSER_VERSION : 0,
            changed ? 1 : 0,
            moved ? 1 : 0,
            moved ? 1 : 0,
          );
        try {
          write(kept);
        } catch {
          // The row's problem, not the advance's: kept without its body, with a warning.
          write(UNSTORED);
        }
      }
      const walk = this.walkState();
      if (only) {
        this.apply(only, cmp.files);
        this.store.exec("UPDATE commits SET listed = ? WHERE sha = ?", [...touchedDirs].map((d) => `,${d},`).join(""), only.sha);
      } else if (touchedDirs.size) {
        for (const c of cmp.commits) this.listCommit(c);
        if (cmp.totalCommits > cmp.commits.length) walk.tasks.unshift({ kind: "range", base, head, page: 2 });
      }
      this.setMeta("walk", JSON.stringify(walk));
      this.setMeta("dirs", dirsNow ? JSON.stringify(dirsNow) : null);
      this.setMeta("cursor", head);
      this.setMeta("as_of", this.now());
      this.bump();
    });
    // The range's commits: a page more of them and a few details now, the rest from the alarm.
    if (!only && touchedDirs.size) await this.walkStep(1, ADVANCE_DETAILS);
    return "done";
  }

  private link(number: number, sessionId: string, at: string): void {
    this.store.exec(
      "INSERT INTO links (number, session_id, last_at) VALUES (?, ?, ?) ON CONFLICT (number, session_id) DO UPDATE SET last_at = MAX(last_at, excluded.last_at)",
      number,
      sessionId,
      at,
    );
  }

  // ------------------------------------------------------------------ walk

  private walkState(): WalkState {
    return this.metaJson<WalkState>("walk") ?? { tasks: [] };
  }

  /** Nothing left to list or detail: the revisions are the whole history. */
  private walkDone(): boolean {
    if (this.meta("cursor") === null) return false;
    if (this.walkState().tasks.length) return false;
    return this.store.exec<{ n: number }>("SELECT COUNT(*) AS n FROM commits WHERE detailed = 0")[0]!.n === 0;
  }

  /**
   * Up to `pages` pages of folder commits, then up to `details` commits' files, newest first,
   * while the quota is spare. Each commit's files are applied in one transaction.
   */
  private async walkStep(pages: number, details: number): Promise<void> {
    const gh = this.client();
    if (!gh) return;
    for (let i = 0; i < pages && gh.spare(); i++) {
      const walk = this.walkState();
      const task = walk.tasks[0];
      if (!task) break;
      if (task.kind === "range") {
        // Null: the base is gone (a rewritten history); the rebuild that follows lists everything.
        const cmp = await gh.compare(task.base, task.head, task.page);
        this.store.transaction(() => {
          const now = this.walkState();
          const t = now.tasks.find((x) => x.kind === "range" && x.base === task.base && x.head === task.head && x.page === task.page);
          if (!t) return;
          for (const c of cmp?.commits ?? []) this.listCommit(c);
          if (!cmp || cmp.commits.length < PER_PAGE_MAX || task.page * PER_PAGE_MAX >= cmp.totalCommits) now.tasks.splice(now.tasks.indexOf(t), 1);
          else t.page += 1;
          this.setMeta("walk", JSON.stringify(now));
        });
        continue;
      }
      const list = await gh.commits({ sha: task.head, path: task.dir, page: task.page, perPage: PER_PAGE_MAX });
      this.store.transaction(() => {
        const now = this.walkState();
        const t = now.tasks.find((x): x is DirTask => x.kind !== "range" && x.dir === task.dir && x.head === task.head && x.page === task.page);
        if (!t) return;
        const mark = `,${t.dir},`;
        let done = list.length < PER_PAGE_MAX;
        for (const c of list) {
          const known = this.store.exec<{ listed: string }>("SELECT listed FROM commits WHERE sha = ?", c.sha)[0];
          if (known?.listed.includes(mark)) {
            done = true;
            break;
          }
          this.store.exec(
            `INSERT INTO commits (sha, at, author_name, author_email, message, detailed, listed) VALUES (?, ?, ?, ?, ?, 0, ?)
             ON CONFLICT (sha) DO UPDATE SET listed = listed || excluded.listed`,
            c.sha,
            c.at,
            c.authorName.slice(0, 200),
            c.authorEmail,
            c.message.slice(0, 10_000),
            mark,
          );
        }
        if (done) now.tasks.splice(now.tasks.indexOf(t), 1);
        else t.page += 1;
        this.setMeta("walk", JSON.stringify(now));
      });
    }
    const todo = this.store.exec<{ sha: string } & Row>(
      `SELECT sha FROM commits WHERE detailed = 0 AND NOT EXISTS (SELECT 1 FROM failures f WHERE f.k = 'commit:' || commits.sha AND f.retry_at > ?)
       ORDER BY at DESC, sha DESC LIMIT ?`,
      this.now(),
      details,
    );
    for (const { sha } of todo) {
      if (!gh.spare()) break;
      let c: Awaited<ReturnType<WorkGitHub["commit"]>>;
      try {
        c = await gh.commit(sha);
      } catch (error) {
        if (!(error instanceof GitHubUnavailable)) throw error;
        // Asked again after a backoff, the others first; after FAILURE_TRIES, given up (detailed -1).
        if (this.failed(`commit:${sha}`)) {
          console.warn(`Work index: commit ${sha} could not be read after ${FAILURE_TRIES} tries; its changes are left out of the history: ${error.message}`);
          this.store.exec("UPDATE commits SET detailed = -1 WHERE sha = ?", sha);
        }
        // GitHub may be failing as a whole: no more this step.
        break;
      }
      this.store.transaction(() => {
        this.store.exec("DELETE FROM failures WHERE k = ?", `commit:${sha}`);
        this.apply(c, c.files);
        this.bump();
      });
    }
  }

  /** A commit of an advance's range, to detail (a merge's files repeat its branch's: not detailed). */
  private listCommit(c: CommitInfo): void {
    if (c.merge) return;
    this.store.exec(
      "INSERT INTO commits (sha, at, author_name, author_email, message, detailed) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (sha) DO NOTHING",
      c.sha,
      c.at,
      c.authorName.slice(0, 200),
      c.authorEmail,
      c.message.slice(0, 10_000),
    );
  }

  /**
   * One commit's item files: a revision of each item, its links, and the dates and names the
   * commit settles (the add, the move into done/, the latest change). Order-free: the walk may
   * see commits in any order.
   */
  private apply(c: CommitInfo, files: FileChange[]): void {
    const store = this.store;
    const trailers = sessionTrailers(c.message);
    const at = c.at ?? "";
    const author = authorName(c);
    const email = c.authorEmail?.trim().toLowerCase() || null;
    // A commit across many items (a rename, a sweep) is nobody's work on any one of them.
    const bulk = itemNumbers(files).size > BULK_ITEMS;
    for (const f of files) {
      const ip = itemPath(f.filename);
      const from = f.previousFilename ? itemPath(f.previousFilename) : null;
      for (const number of new Set([ip?.number, from?.number].filter((n): n is number => n !== undefined))) {
        store.exec(
          "INSERT INTO revisions (number, sha, path, at, author_name, summary, session_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          number,
          c.sha,
          f.filename,
          at,
          c.authorName.slice(0, 200),
          summaryOf(c.message),
          trailers[0] ?? null,
        );
        const row = store.exec<{ path: string; stage: string; created_at: string | null; closed_at: string | null; updated_at: string | null; activity_at: string | null } & Row>(
          "SELECT path, stage, created_at, closed_at, updated_at, activity_at FROM items WHERE number = ?",
          number,
        )[0];
        if (!row) continue;
        for (const sessionId of trailers) this.link(number, sessionId, at);
        if (c.at === null) continue;
        if (row.updated_at === null || c.at > row.updated_at) {
          store.exec("UPDATE items SET updated_at = ?, updated_name = ?, updated_email = ? WHERE number = ?", c.at, author, email, number);
        }
        if (!bulk && (row.activity_at === null || c.at > row.activity_at)) {
          store.exec("UPDATE items SET activity_at = ?, activity_name = ?, activity_email = ? WHERE number = ?", c.at, author, email, number);
        }
        const mine = ip !== null && ip.number === number;
        if (mine && (f.status === "added" || (f.status === "renamed" && !from)) && (row.created_at === null || c.at < row.created_at)) {
          store.exec("UPDATE items SET created_at = ?, author_name = ?, author_email = ? WHERE number = ?", c.at, c.authorName.slice(0, 200), c.authorEmail, number);
        }
        const closes = mine && ip.stage === "closed" && (f.status === "added" || (f.status === "renamed" && from?.stage !== "closed"));
        if (closes && row.stage === "closed" && (row.closed_at === null || c.at > row.closed_at)) {
          store.exec("UPDATE items SET closed_at = ?, closed_by = ? WHERE number = ?", c.at, closerName(c), number);
        }
      }
    }
    store.exec(
      `INSERT INTO commits (sha, at, author_name, author_email, message, detailed) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (sha) DO UPDATE SET detailed = 1`,
      c.sha,
      c.at,
      c.authorName.slice(0, 200),
      c.authorEmail,
      c.message.slice(0, 10_000),
    );
  }

  // ------------------------------------------------------------------ pull requests

  /**
   * At most every 5 minutes while read: one query for the open items' pull requests asked longest
   * ago (never asked first). Merged and closed are final; unreadable is asked again after a day.
   * GraphQL has its own pause.
   */
  private async refreshPulls(gh: WorkGitHub): Promise<void> {
    const now = this.now();
    if (now - this.metaNumber("read_at") >= READS_WINDOW_MS) return;
    if (now - this.metaNumber("pulls_at") < PULLS_EVERY_MS) return;
    if (this.metaNumber("pulls_pause_until") > now || !gh.spare("graphql")) return;
    const known = new Map(this.store.exec<{ url: string; state: string | null; checked_at: string } & Row>("SELECT url, state, checked_at FROM pulls").map((r) => [r.url, r]));
    const recheck = new Date(now - UNREADABLE_RECHECK_MS).toISOString();
    const due = new Map<string, string>();
    for (const r of this.store.exec<{ parsed: string }>("SELECT parsed FROM items WHERE stage = 'open' AND parser > 0")) {
      for (const url of (JSON.parse(r.parsed) as ParsedItem).pullRequests) {
        if (!pullOf(url) || due.has(url)) continue;
        const k = known.get(url);
        if (k && (k.state === "merged" || k.state === "closed")) continue;
        if (k && k.state === "unreadable" && k.checked_at > recheck) continue;
        due.set(url, k?.checked_at ?? "");
      }
    }
    if (!due.size) return;
    const batch = [...due].sort((a, b) => (a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).slice(0, PULLS_PER_QUERY).map(([url]) => url);
    this.setMeta("pulls_at", now);
    let states: Awaited<ReturnType<WorkGitHub["pulls"]>>;
    try {
      states = await gh.pulls(batch);
    } catch (error) {
      // Pull request state is decoration: no failure of it is a problem with the repository.
      if (error instanceof GitHubGone) return;
      throw error;
    }
    const at = new Date(now).toISOString();
    this.store.transaction(() => {
      let changed = false;
      for (const [url, s] of states) {
        const state = s === "unreadable" ? "unreadable" : s.state;
        const title = s === "unreadable" ? null : s.title;
        const k = known.get(url);
        if (!k || k.state !== state || this.store.exec<{ title: string | null }>("SELECT title FROM pulls WHERE url = ?", url)[0]?.title !== title) changed = true;
        this.store.exec(
          "INSERT INTO pulls (url, state, title, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET state = excluded.state, title = excluded.title, checked_at = excluded.checked_at",
          url,
          state,
          title,
          at,
        );
      }
      if (changed) this.bump();
    });
  }

  // ------------------------------------------------------------------ parser version

  private reparsing(): boolean {
    return this.meta("parser_version") !== String(PARSER_VERSION);
  }

  /**
   * After a new parser version, one batch of stored bodies re-parsed, with no GitHub call. Run by
   * the look and the alarm, never while the object starts: a parser fault cannot stop it starting,
   * and reads show the earlier fields until the batch reaches them.
   */
  private reparseBatch(): void {
    if (!this.reparsing()) return;
    const rows = this.store.exec<{ number: number; path: string; body: string; body_note: string | null } & Row>(
      "SELECT number, path, body, body_note FROM items WHERE parser > 0 AND parser <> ? LIMIT ?",
      PARSER_VERSION,
      REPARSE_BATCH,
    );
    this.store.transaction(() => {
      for (const r of rows) {
        const ip = itemPath(r.path);
        if (ip) this.store.exec("UPDATE items SET parsed = ?, parser = ? WHERE number = ?", JSON.stringify(safeParse(ip, r.body, r.body_note)), PARSER_VERSION, r.number);
      }
      if (rows.length < REPARSE_BATCH) this.setMeta("parser_version", PARSER_VERSION);
      this.bump();
    });
  }

  // ------------------------------------------------------------------ rows to items

  private indexed(rows: ItemRow[]): IndexedItem[] {
    const repo = this.repo();
    if (!rows.length || !repo) return [];
    const store = this.store;
    const numbers = rows.map((r) => r.number);
    const others = new Map<number, string[]>();
    const links = new Map<number, string[]>();
    for (const part of chunks(numbers)) {
      for (const f of store.exec<{ number: number; path: string } & Row>(`SELECT number, path FROM files WHERE number IN (${marks(part)}) ORDER BY path`, ...part)) {
        others.set(f.number, [...(others.get(f.number) ?? []), f.path]);
      }
      for (const l of store.exec<{ number: number; session_id: string } & Row>(
        `SELECT number, session_id FROM links WHERE number IN (${marks(part)}) ORDER BY last_at DESC, session_id`,
        ...part,
      )) {
        links.set(l.number, [...(links.get(l.number) ?? []), l.session_id]);
      }
    }
    const parsedRows = rows.map((r) => ({ r, parsed: JSON.parse(r.parsed) as ParsedItem }));
    const urls = [...new Set(parsedRows.flatMap((p) => p.parsed.pullRequests))];
    const pulls = new Map<string, { state: string | null; title: string | null }>();
    for (const part of chunks(urls)) {
      for (const p of store.exec<{ url: string; state: string | null; title: string | null } & Row>(`SELECT url, state, title FROM pulls WHERE url IN (${marks(part)})`, ...part)) pulls.set(p.url, p);
    }
    const recentSince = this.recentSince();
    const blobBase = `https://github.com/${repo.owner}/${repo.name}/blob/${repo.branch.split("/").map(encodeURIComponent).join("/")}`;
    return parsedRows.map(({ r, parsed }) => {
      const stage = r.stage === "closed" ? "closed" : "open";
      // S8: the hidden files are named, so a person can find and renumber them.
      const duplicates = (others.get(r.number) ?? []).filter((p) => p !== r.path).map((p) => `Another file has number ${r.number}: ${p}`);
      return {
        number: r.number,
        stage,
        path: r.path,
        url: `${blobBase}/${r.path.split("/").map(encodeURIComponent).join("/")}`,
        title: parsed.title,
        stateLine: parsed.stateLine,
        tags: parsed.tags,
        owner: ownerOf(parsed.owner, r),
        author: r.author_name !== null ? { name: r.author_name, email: r.author_email } : null,
        left: parsed.left,
        readyToClose: readyToClose(stage, parsed),
        warnings: [...parsed.warnings, ...duplicates],
        pullRequests: parsed.pullRequests.map((url) => {
          const p = pulls.get(url);
          const state = p && p.state !== "unreadable" ? (p.state as IndexedItem["pullRequests"][number]["state"]) : null;
          return { url, state, title: p && p.state !== "unreadable" ? p.title : null };
        }),
        sessionIds: links.get(r.number) ?? [],
        updatedAt: r.updated_at,
        lastActivityAt: r.activity_at,
        recent: r.activity_at !== null && r.activity_at >= recentSince,
        createdAt: r.created_at,
        closedAt: stage === "closed" ? r.closed_at : null,
        closedBy: stage === "closed" ? r.closed_by : null,
        parsed: r.parser > 0,
      };
    });
  }
}

// -------------------------------------------------------------------- helpers

function stageOf(path: string): "open" | "closed" {
  return path.startsWith("done/") ? "closed" : "open";
}

function dirOf(path: string): Dir | null {
  return path.startsWith("work/") ? "work" : path.startsWith("done/") ? "done" : null;
}

/** The row of each number: its open file before a closed one, then the first path. */
function pickWinners(files: { path: string; number: number; blob: string }[]): Map<number, { path: string; number: number; blob: string }> {
  const out = new Map<number, { path: string; number: number; blob: string }>();
  for (const f of files) {
    const cur = out.get(f.number);
    if (!cur) {
      out.set(f.number, f);
      continue;
    }
    const rank = (p: string) => (stageOf(p) === "open" ? 0 : 1);
    if (rank(f.path) < rank(cur.path) || (rank(f.path) === rank(cur.path) && f.path < cur.path)) out.set(f.number, f);
  }
  return out;
}

/** The fields of a row whose body is not read yet: the slug as title. */
function pendingParse(ip: ItemPath): ParsedItem {
  return { title: slugTitle(ip.slug), stateLine: null, tags: [], owner: null, left: null, boxes: 0, pullRequests: [], warnings: [] };
}

type BodyNote = "cut" | "unstored" | "unread";
interface KeptBody {
  body: string;
  note: BodyNote | null;
}
const UNSTORED: KeptBody = { body: "", note: "unstored" };
const UNREAD: KeptBody = { body: "", note: "unread" };

function keptNote(note: string | null): BodyNote | null {
  return note === "cut" || note === "unstored" || note === "unread" ? note : null;
}

/** A file's text as it is stored: at most BODY_STORE_BYTES of UTF-8, cut at a character boundary. */
export function keepBody(text: string): KeptBody {
  // A UTF-16 unit is at most 3 bytes: shorter text needs no encoding to know it fits.
  if (text.length * 3 <= BODY_STORE_BYTES) return { body: text, note: null };
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= BODY_STORE_BYTES) return { body: text, note: null };
  let end = BODY_STORE_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { body: new TextDecoder().decode(bytes.subarray(0, end)), note: "cut" };
}

/** The parser never throws by design; if it does, the row keeps its slug and says so. */
function safeParse(ip: ItemPath, body: string, note: string | null = null): ParsedItem {
  if (note === "unstored") return { ...pendingParse(ip), warnings: ["The file could not be stored; only its name is shown."] };
  if (note === "unread") return { ...pendingParse(ip), warnings: ["GitHub would not give the file; only its name is shown. It is read again when it changes."] };
  let parsed: ParsedItem;
  try {
    parsed = parseItem(ip, body);
  } catch {
    return { ...pendingParse(ip), warnings: ["The file could not be read."] };
  }
  if (note === "cut") parsed.warnings = [`The file is larger than ${BODY_STORE_BYTES / 1_000_000} MB; only the start is read.`, ...parsed.warnings];
  return parsed;
}

/** Who closed: the commit's author, or null when a session made the commit (it says "closed in a session"). */
function closerName(c: CommitInfo): string | null {
  if (sessionTrailers(c.message).length) return null;
  return authorName(c);
}

/** The commit author's name without the " via Computer" a session's commit carries; null when empty. */
function authorName(c: CommitInfo): string | null {
  // By hand, not `/\s+via Computer$/`: an unanchored `\s+` backtracks on a run of spaces.
  const name = c.authorName.slice(0, 200).trim();
  const suffix = " via computer";
  return (name.toLowerCase().endsWith(suffix) ? name.slice(0, -suffix.length) : name).trim() || null;
}

/** The items a commit's files touch, by number (a rename counts both ends). */
function itemNumbers(files: FileChange[]): Set<number> {
  const out = new Set<number>();
  for (const f of files) {
    const ip = itemPath(f.filename);
    if (ip) out.add(ip.number);
    const from = f.previousFilename ? itemPath(f.previousFilename) : null;
    if (from) out.add(from.number);
  }
  return out;
}

/**
 * The frontmatter owner; else the author of the latest change that was not a bulk edit; else of
 * the latest change of any kind. A commit with no email names no owner.
 */
function ownerOf(declared: string | null, r: ItemRow): IndexedOwner | null {
  if (declared) return { email: declared, name: null, source: "declared" };
  if (r.activity_email) return { email: r.activity_email, name: r.activity_name, source: "derived" };
  if (r.updated_email) return { email: r.updated_email, name: r.updated_name, source: "derived" };
  return null;
}

function summaryOf(message: string): string {
  const end = message.indexOf("\n");
  return (end === -1 ? message : message.slice(0, end)).replace(/\r$/, "").slice(0, 200);
}

function commitUrl(repo: WorkRepo, sha: string): string {
  return `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`;
}

function marks(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += BIND_MAX) out.push(values.slice(i, i + BIND_MAX));
  return out;
}

function encodeCursor(value: Record<string, number | string>): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeCursor(cursor: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function parallel<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(FETCH_PARALLEL, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(lanes);
}

/** Most recently pushed first, never pushed last, then by name. */
function byPushed(a: GrantedRepository, b: GrantedRepository): number {
  if (a.pushedAt !== b.pushedAt) {
    if (a.pushedAt === null) return 1;
    if (b.pushedAt === null) return -1;
    return Date.parse(b.pushedAt) - Date.parse(a.pushedAt);
  }
  return a.name.localeCompare(b.name);
}
