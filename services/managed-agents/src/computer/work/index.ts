// The Work index (work tracking, tech design 3.6): one organization's projection of its knowledge
// repository's `work/` and `done/` folders, kept in SQLite and moved forward from a cursor commit.
// The repository is the record; this is a cache that can always be rebuilt from it.
//
// - Advance (the only way the projection changes, besides a build): compare `cursor...head`, fetch
//   the blobs of the changed item files, then write rows, links and the cursor in one transaction.
//   A crash before the transaction repeats the work with the same result.
// - Build (no cursor, or the head is not ahead of it): list the two folders at the head; open items
//   are read in batches of 50 continued by the alarm, and the cursor is set when they are done.
//   Closed items get a row from the listing and are read when a page of them is asked for. Then a
//   background walk of the commits recovers links, authors and close dates within the quota.
// - Duplicate numbers: `files` holds every item file at the cursor; the row of a number is its open
//   file before a closed one, then the first path. The others show as a warning on the row.
// - One GitHub task at a time (`exclusive`): look, build, fill, walk, pull state, setRepository.
//   Reads are SQL and never wait on GitHub, except a page of closed items not read yet (bounded).
//
// Close and Reopen (3.9, build step 5) are writes in the same chain: a commit through the
// contents API, then an advance to it.

import {
  GitHubGone,
  GitHubPaused,
  GitHubUnavailable,
  pullOf,
  WorkGitHub,
  type CommitInfo,
  type FileChange,
  type RepositoryProblem,
  type TokenMinter,
  type WorkRepo,
} from "./github.js";
import type {
  HistoryResult,
  IndexedItem,
  ItemResult,
  ItemsQuery,
  ItemsResult,
  ReadState,
  Repository,
  RepositoryChoice,
  Revision,
  WorkActor,
  WorkWrite,
} from "./index-contract.js";
import { itemPath, PARSER_VERSION, parseItem, readyToClose, sessionTrailers, slugTitle, type ItemPath, type ParsedItem } from "./item.js";

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
const PULLS_PER_QUERY = 50;
/** An advance asks per-commit files for at most this many commits. */
const DETAIL_CAP = 20;
/** Compare lists at most 300 files; at that many, the listing may be cut: rebuild. */
const COMPARE_FILES_MAX = 300;
/** A page of closed items waits this long for bodies not read yet, then answers with what it has. */
const LAZY_WAIT_MS = 5_000;
const WALK_PAGE = 30;
const WALK_COMMITS_PER_TICK = 10;
const HISTORY_PAGE = 30;
const CLOSED_LIMIT_DEFAULT = 50;
const CLOSED_LIMIT_MAX = 100;
const FETCH_PARALLEL = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  number INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  body TEXT NOT NULL,
  parsed TEXT NOT NULL,
  parser INTEGER NOT NULL,
  author_name TEXT, author_email TEXT, created_at TEXT,
  updated_at TEXT, closed_at TEXT, closed_by TEXT
);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, number INTEGER NOT NULL, blob TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS files_number ON files (number);
CREATE TABLE IF NOT EXISTS links (number INTEGER NOT NULL, session_id TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY (number, session_id));
CREATE TABLE IF NOT EXISTS pulls (url TEXT PRIMARY KEY, state TEXT, title TEXT, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/** What the index needs of its Durable Object. */
export interface WorkIndexDeps {
  sql: SqlStorage;
  transaction<T>(fn: () => T): T;
  /** The organization's Account object. */
  account(accountId: string): TokenMinter;
  /** Makes sure the alarm fires at `at` or sooner. */
  arm(at: number): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
  fetch?: typeof fetch;
  now?: () => number;
}

interface ItemRow {
  number: number;
  path: string;
  blob: string;
  body: string;
  parsed: string;
  parser: number;
  author_name: string | null;
  author_email: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  closed_by: string | null;
}

type Row = Record<string, SqlStorageValue>;

interface StoredRepo extends WorkRepo {}

interface WalkState {
  head: string;
  dir: "work" | "done";
  page: number;
  index: number;
}

/** One organization's Work index. */
export class WorkIndex {
  private readonly now: () => number;
  private github: WorkGitHub | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private looking: Promise<void> | null = null;
  private readonly filling = new Set<number>();

  constructor(private readonly deps: WorkIndexDeps) {
    this.now = deps.now ?? Date.now;
    deps.sql.exec(SCHEMA);
    this.reparse();
  }

  // ------------------------------------------------------------------ meta

  private meta(k: string): string | null {
    const row = this.deps.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return row ? row.v : null;
  }

  private setMeta(k: string, v: string | number | null): void {
    if (v === null) this.deps.sql.exec("DELETE FROM meta WHERE k = ?", k);
    else this.deps.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, String(v));
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

  /** The organization the object serves; recorded on the first call so the alarm knows it. */
  private bind(accountId: string): void {
    if (this.meta("account_id") !== accountId) this.setMeta("account_id", accountId);
  }

  private repo(): StoredRepo | null {
    return this.metaJson<StoredRepo>("repo");
  }

  private client(): WorkGitHub | null {
    const repo = this.repo();
    const accountId = this.meta("account_id");
    if (!repo || !accountId) return null;
    const g = this.github;
    if (g && g.repo.installationId === repo.installationId && g.repo.owner === repo.owner && g.repo.name === repo.name && g.repo.branch === repo.branch) return g;
    this.github = new WorkGitHub({ repo, account: this.deps.account(accountId), now: this.now, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) });
    return this.github;
  }

  private repository(): Repository | null {
    const repo = this.repo();
    if (!repo) return null;
    return { installationId: repo.installationId, owner: repo.owner, name: repo.name, branch: repo.branch, problem: (this.meta("problem") as RepositoryProblem | null) ?? null };
  }

  private readState(): ReadState {
    const asOf = this.metaNumber("as_of");
    const build = this.metaJson<{ head: string }>("build");
    return {
      head: this.meta("cursor") ?? build?.head ?? null,
      asOf: asOf ? new Date(asOf).toISOString() : null,
      building: build !== null,
      problem: (this.meta("problem") as RepositoryProblem | null) ?? null,
    };
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
    if (now - seen > LOOK_AFTER_MS) this.deps.waitUntil(this.kick());
    this.deps.waitUntil(this.deps.arm(now + ALARM_EVERY_MS));
  }

  // ------------------------------------------------------------------ RPC

  async getRepository(accountId: string): Promise<Repository | null> {
    this.bind(accountId);
    return this.repository();
  }

  async poke(accountId: string): Promise<void> {
    this.bind(accountId);
    if (!this.repo()) return;
    this.deps.waitUntil(this.kick());
  }

  async setRepository(accountId: string, choice: RepositoryChoice, _by: WorkActor): Promise<WorkWrite<Repository>> {
    this.bind(accountId);
    return this.exclusive(async () => {
      const trial = new WorkGitHub({
        repo: { installationId: choice.installationId, owner: choice.owner, name: choice.name, branch: choice.branch ?? "main" },
        account: this.deps.account(accountId),
        now: this.now,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      let repo: StoredRepo;
      try {
        const found = await trial.repository();
        repo = { installationId: choice.installationId, owner: found.owner, name: found.name, branch: choice.branch ?? found.defaultBranch };
        const checked = new WorkGitHub({ repo, account: this.deps.account(accountId), now: this.now, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) });
        await checked.head();
      } catch (error) {
        if (error instanceof GitHubGone) {
          const field = error.problem === "branch_not_found" ? "branch" : error.problem === "repository_not_found" ? "name" : "installationId";
          return { ok: false, status: 400, code: "invalid_request", message: refusal(error.problem), field, reason: error.problem };
        }
        const retryAfterMs = error instanceof GitHubPaused ? Math.max(1000, error.until - this.now()) : 5_000;
        return { ok: false, status: 503, code: "unavailable", message: "GitHub could not be reached. Try again shortly.", retryAfterMs };
      }
      const current = this.repo();
      const same =
        current !== null &&
        current.installationId === repo.installationId &&
        current.owner.toLowerCase() === repo.owner.toLowerCase() &&
        current.name.toLowerCase() === repo.name.toLowerCase() &&
        current.branch === repo.branch;
      this.deps.transaction(() => {
        if (!same) {
          for (const table of ["items", "files", "links", "pulls"]) this.deps.sql.exec(`DELETE FROM ${table}`);
          for (const k of ["cursor", "build", "walk", "head_etag", "as_of", "tried_at", "pulls_at", "pause_until"]) this.setMeta(k, null);
        }
        this.setMeta("repo", JSON.stringify(repo));
        this.setMeta("problem", null);
      });
      this.github = null;
      this.deps.waitUntil(this.kick());
      return { ok: true, value: this.repository()! };
    });
  }

  async items(accountId: string, query: ItemsQuery): Promise<ItemsResult> {
    this.bind(accountId);
    this.noteRead();
    const repository = this.repository();
    if (query.stage === "open") {
      const rows = this.deps.sql.exec<ItemRow & Row>("SELECT * FROM items WHERE path LIKE 'work/%' ORDER BY number").toArray();
      return { ok: true, ...this.readState(), repository, items: this.indexed(rows), nextCursor: null };
    }
    let before = Number.MAX_SAFE_INTEGER;
    if (query.cursor !== undefined) {
      const n = decodeCursor(query.cursor, "n");
      if (n === null) return { ok: false, error: "invalid_cursor" };
      before = n;
    }
    const limit = Math.min(Math.max(query.limit ?? CLOSED_LIMIT_DEFAULT, 1), CLOSED_LIMIT_MAX);
    const select = () =>
      this.deps.sql.exec<ItemRow & Row>("SELECT * FROM items WHERE path LIKE 'done/%' AND number < ? ORDER BY number DESC LIMIT ?", before, limit + 1).toArray();
    let rows = select();
    const pending = rows.slice(0, limit).filter((r) => r.parser === 0);
    if (pending.length) {
      await this.fillLater(pending);
      rows = select();
    }
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor({ n: page[page.length - 1]!.number }) : null;
    return { ok: true, ...this.readState(), repository, items: this.indexed(page), nextCursor };
  }

  async item(accountId: string, number: number): Promise<ItemResult> {
    this.bind(accountId);
    this.noteRead();
    const select = () => this.deps.sql.exec<ItemRow & Row>("SELECT * FROM items WHERE number = ?", number).toArray()[0];
    let row = select();
    if (row && row.parser === 0) {
      await this.fillLater([row]);
      row = select();
    }
    return { ...this.readState(), repository: this.repository(), item: row ? this.indexed([row])[0]! : null, body: row && row.parser > 0 ? row.body : null };
  }

  async history(accountId: string, number: number, cursor?: string): Promise<HistoryResult> {
    this.bind(accountId);
    this.noteRead();
    const row = this.deps.sql.exec<{ path: string }>("SELECT path FROM items WHERE number = ?", number).toArray()[0];
    if (!row) return { ok: false, error: "item_not_found" };
    let page = 1;
    if (cursor !== undefined) {
      const p = decodeCursor(cursor, "p");
      if (p === null || p < 1) return { ok: false, error: "invalid_cursor" };
      page = p;
    }
    const gh = this.client();
    const head = this.readState().head;
    const repo = this.repo();
    if (!gh || !head || !repo) return { ok: false, error: "unavailable", retryAfterMs: 5_000 };
    const file = row.path.slice(row.path.indexOf("/") + 1);
    try {
      const lists = await Promise.all(["work", "done"].map((dir) => gh.commits({ sha: head, path: `${dir}/${file}`, page, perPage: HISTORY_PAGE })));
      const seen = new Set<string>();
      const revisions: Revision[] = [];
      for (const c of lists.flat().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
        if (seen.has(c.sha)) continue;
        seen.add(c.sha);
        revisions.push({
          sha: c.sha,
          url: `https://github.com/${repo.owner}/${repo.name}/commit/${c.sha}`,
          at: c.at,
          authorName: c.authorName,
          summary: c.message.split(/\r?\n/, 1)[0]!.slice(0, 200),
          sessionId: sessionTrailers(c.message)[0] ?? null,
        });
      }
      const more = lists.some((l) => l.length >= HISTORY_PAGE);
      return { ok: true, ...this.readState(), revisions, nextCursor: more ? encodeCursor({ p: page + 1 }) : null };
    } catch (error) {
      if (error instanceof GitHubGone) this.problem(error.problem);
      const retryAfterMs = error instanceof GitHubPaused ? Math.max(1000, error.until - this.now()) : 5_000;
      return { ok: false, error: "unavailable", retryAfterMs };
    }
  }

  /** The alarm: continue a build, look while there are readers, walk. Returns when to come back. */
  async alarm(): Promise<number | null> {
    if (!this.repo()) return null;
    await this.exclusive(async () => {
      const now = this.now();
      if (this.meta("build") !== null) {
        if (now - this.metaNumber("as_of") >= ALARM_EVERY_MS) await this.look();
        else await this.guard(() => this.fillOpen());
        return;
      }
      if (now - this.metaNumber("read_at") < READS_WINDOW_MS) await this.look();
      else await this.guard(() => this.walkTick());
    });
    const now = this.now();
    const pausedUntil = this.metaNumber("pause_until");
    let next: number | null = null;
    if (this.meta("build") !== null) next = now + BUILD_STEP_MS;
    else if (now - this.metaNumber("read_at") < READS_WINDOW_MS || this.meta("walk") !== null) next = now + ALARM_EVERY_MS;
    if (next !== null && this.meta("problem") !== null && now - this.metaNumber("read_at") >= READS_WINDOW_MS) next = null;
    if (next !== null && pausedUntil > next) next = pausedUntil;
    return next;
  }

  // ------------------------------------------------------------------ looking

  /** Runs `fn` with GitHub failures recorded: a pause until it ends, a permanent failure as the problem. */
  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (error instanceof GitHubGone) this.problem(error.problem);
      else if (error instanceof GitHubPaused) this.setMeta("pause_until", error.until);
      else if (!(error instanceof GitHubUnavailable)) throw error;
    }
  }

  private problem(problem: RepositoryProblem): void {
    this.setMeta("problem", problem);
  }

  /** Checks the head and moves the projection to it; then one step of background work. */
  private async look(): Promise<void> {
    const gh = this.client();
    if (!gh) return;
    if (this.metaNumber("pause_until") > this.now()) return;
    this.setMeta("tried_at", this.now());
    await this.guard(async () => {
      const etag = this.meta("head_etag") ?? undefined;
      const head = await gh.head(etag);
      this.setMeta("problem", null);
      if (head !== "unchanged") {
        const cursor = this.meta("cursor");
        const build = this.metaJson<{ head: string }>("build");
        if (build) {
          // A build in progress finishes at its head; the next look advances from there.
        } else if (cursor === null) {
          await this.build(gh, head.sha);
        } else if (cursor !== head.sha) {
          const result = await this.advance(gh, cursor, head.sha);
          if (result === "rebuild") await this.build(gh, head.sha);
        }
        if (this.meta("cursor") === head.sha && head.etag) this.setMeta("head_etag", head.etag);
      }
      this.setMeta("as_of", this.now());
      if (this.meta("build") !== null) {
        await this.fillOpen();
        if (this.meta("build") !== null) this.deps.waitUntil(this.deps.arm(this.now() + BUILD_STEP_MS));
      } else if (this.meta("walk") !== null) {
        await this.walkTick();
      }
      await this.refreshPulls(gh);
    });
  }

  // ------------------------------------------------------------------ build

  /** Lists `work/` and `done/` at `head`; open items are read by `fillOpen`, closed ones on demand. */
  private async build(gh: WorkGitHub, head: string): Promise<void> {
    const root = await gh.tree(head);
    if (!root) throw new GitHubUnavailable(`GitHub has no tree for ${head}.`);
    const listing = new Map<string, { number: number; blob: string }>();
    for (const dir of ["work", "done"] as const) {
      const entry = root.entries.find((e) => e.name === dir && e.type === "tree");
      if (!entry) continue;
      const tree = await gh.tree(entry.sha);
      for (const e of tree?.entries ?? []) {
        const path = `${dir}/${e.name}`;
        const ip = e.type === "blob" ? itemPath(path) : null;
        if (ip) listing.set(path, { number: ip.number, blob: e.sha });
      }
    }
    const winners = pickWinners([...listing].map(([path, f]) => ({ path, ...f })));
    const sql = this.deps.sql;
    this.deps.transaction(() => {
      sql.exec("DELETE FROM files");
      for (const [path, f] of listing) sql.exec("INSERT INTO files (path, number, blob) VALUES (?, ?, ?)", path, f.number, f.blob);
      const old = new Map(sql.exec<ItemRow & Row>("SELECT * FROM items").toArray().map((r) => [r.number, r]));
      for (const [number] of old) {
        if (!winners.has(number)) {
          sql.exec("DELETE FROM items WHERE number = ?", number);
          sql.exec("DELETE FROM links WHERE number = ?", number);
        }
      }
      for (const [number, w] of winners) {
        const ip = itemPath(w.path)!;
        const prev = old.get(number);
        if (prev && prev.blob === w.blob) {
          if (prev.path !== w.path) {
            const moved = stageOf(prev.path) !== ip.stage;
            sql.exec(
              "UPDATE items SET path = ?, parsed = ?, closed_at = ?, closed_by = ? WHERE number = ?",
              w.path,
              prev.parser > 0 ? JSON.stringify(parseItem(ip, prev.body)) : JSON.stringify(pendingParse(ip)),
              moved ? null : prev.closed_at,
              moved ? null : prev.closed_by,
              number,
            );
          }
          continue;
        }
        if (prev) {
          const moved = stageOf(prev.path) !== ip.stage;
          sql.exec(
            "UPDATE items SET path = ?, blob = ?, body = '', parsed = ?, parser = 0, updated_at = NULL, closed_at = ?, closed_by = ? WHERE number = ?",
            w.path,
            w.blob,
            JSON.stringify(pendingParse(ip)),
            moved ? null : prev.closed_at,
            moved ? null : prev.closed_by,
            number,
          );
        } else {
          sql.exec("INSERT INTO items (number, path, blob, body, parsed, parser) VALUES (?, ?, ?, '', ?, 0)", number, w.path, w.blob, JSON.stringify(pendingParse(ip)));
        }
      }
      this.setMeta("cursor", null);
      this.setMeta("head_etag", null);
      this.setMeta("walk", null);
      this.setMeta("build", JSON.stringify({ head }));
    });
  }

  /** One batch of open items not read yet; the cursor is set when none is left. */
  private async fillOpen(): Promise<void> {
    const build = this.metaJson<{ head: string }>("build");
    const gh = this.client();
    if (!build || !gh) return;
    const rows = this.deps.sql.exec<ItemRow & Row>("SELECT * FROM items WHERE parser = 0 AND path LIKE 'work/%' ORDER BY number LIMIT ?", FILL_BATCH).toArray();
    await parallel(rows, (row) => this.fill(gh, row, build.head));
    const left = this.deps.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE parser = 0 AND path LIKE 'work/%'").toArray()[0]!.n;
    if (left > 0) return;
    this.deps.transaction(() => {
      this.setMeta("cursor", build.head);
      this.setMeta("build", null);
      this.setMeta("walk", JSON.stringify({ head: build.head, dir: "work", page: 1, index: 0 } satisfies WalkState));
    });
  }

  /** Reads one row's body; written only if the row still has that blob. */
  private async fill(gh: WorkGitHub, row: ItemRow, head: string | null): Promise<void> {
    const ip = itemPath(row.path);
    if (!ip) return;
    const body = await gh.blob(row.blob);
    let updatedAt = row.updated_at;
    if (updatedAt === null && head !== null && stageOf(row.path) === "open") {
      updatedAt = (await gh.commits({ sha: head, path: row.path, page: 1, perPage: 1 }))[0]?.at ?? null;
    }
    this.deps.sql.exec(
      "UPDATE items SET body = ?, parsed = ?, parser = ?, updated_at = COALESCE(updated_at, ?) WHERE number = ? AND blob = ? AND path = ?",
      body,
      JSON.stringify(parseItem(ip, body)),
      PARSER_VERSION,
      updatedAt,
      row.number,
      row.blob,
      row.path,
    );
  }

  /** Closed items asked for before they were read: read them, waiting at most LAZY_WAIT_MS. */
  private async fillLater(rows: ItemRow[]): Promise<void> {
    const gh = this.client();
    if (!gh || gh.paused()) return;
    const todo = rows.filter((r) => !this.filling.has(r.number));
    if (!todo.length) return;
    for (const r of todo) this.filling.add(r.number);
    const work = parallel(todo, (row) => this.guard(() => this.fill(gh, row, null))).finally(() => {
      for (const r of todo) this.filling.delete(r.number);
    });
    this.deps.waitUntil(work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, LAZY_WAIT_MS)))]);
    clearTimeout(timer);
  }

  // ------------------------------------------------------------------ advance

  /** `base...head` applied in one transaction; "rebuild" when the head is not ahead of the cursor. */
  async advance(gh: WorkGitHub, base: string, head: string): Promise<"done" | "rebuild"> {
    const cmp = await gh.compare(base, head);
    if (!cmp || cmp.status !== "ahead" || cmp.files.length >= COMPARE_FILES_MAX || cmp.totalCommits > cmp.commits.length) return "rebuild";
    const commits = cmp.commits;
    const newest = commits[commits.length - 1];
    const isItemChange = (f: FileChange) => itemPath(f.filename) !== null || (f.previousFilename !== null && itemPath(f.previousFilename) !== null);
    const changes = cmp.files.filter(isItemChange);

    // Which commit touched which file: the range's files for one commit; else per commit, for the
    // commits with a trailer, and for all of them when an item was added or moved (authors, close dates).
    const perCommit = new Map<string, FileChange[]>();
    if (changes.length) {
      if (commits.length === 1) perCommit.set(commits[0]!.sha, cmp.files);
      else {
        const moved = changes.some((f) => f.status === "added" || f.status === "renamed");
        const wanted = commits.filter((c) => (moved && commits.length <= DETAIL_CAP) || sessionTrailers(c.message).length > 0).slice(-DETAIL_CAP);
        for (const c of wanted) perCommit.set(c.sha, (await gh.commit(c.sha)).files);
      }
    }
    const complete = perCommit.size === commits.length;

    // Per new path: the newest commit that touched it, the one that added it, the one that closed it.
    const touch = new Map<string, { last?: CommitInfo; added?: CommitInfo; closed?: CommitInfo }>();
    for (const c of commits) {
      for (const f of perCommit.get(c.sha) ?? []) {
        const t = touch.get(f.filename) ?? {};
        t.last = c;
        const from = f.previousFilename ? itemPath(f.previousFilename) : null;
        if (f.status === "added" || (f.status === "renamed" && !from)) t.added ??= c;
        if (f.filename.startsWith("done/") && (f.status === "added" || (f.status === "renamed" && from?.stage !== "closed"))) t.closed = c;
        touch.set(f.filename, t);
      }
    }

    // The files of the affected numbers after the range, and the row each number gets.
    const numbers = new Set<number>();
    for (const f of changes) {
      for (const p of [f.filename, f.previousFilename]) {
        const ip = p ? itemPath(p) : null;
        if (ip) numbers.add(ip.number);
      }
    }
    const files = new Map<string, { number: number; blob: string }>();
    for (const n of numbers) {
      for (const r of this.deps.sql.exec<{ path: string; blob: string } & Row>("SELECT path, blob FROM files WHERE number = ?", n).toArray()) files.set(r.path, { number: n, blob: r.blob });
    }
    const removed = new Set<string>();
    for (const f of changes) {
      if (f.status === "removed" || f.status === "renamed") {
        const gone = f.status === "removed" ? f.filename : f.previousFilename!;
        files.delete(gone);
        removed.add(gone);
      }
      if (f.status !== "removed") {
        const ip = itemPath(f.filename);
        if (ip && f.sha) {
          files.set(f.filename, { number: ip.number, blob: f.sha });
          removed.delete(f.filename);
        }
      }
    }
    const winners = pickWinners([...files].map(([path, f]) => ({ path, ...f })));
    const old = new Map<number, ItemRow>();
    for (const n of numbers) {
      const r = this.deps.sql.exec<ItemRow & Row>("SELECT * FROM items WHERE number = ?", n).toArray()[0];
      if (r) old.set(n, r);
    }

    // Bodies to read, before the transaction.
    const needed = [...winners.values()].filter((w) => {
      const prev = old.get(w.number);
      return !prev || prev.blob !== w.blob || prev.parser === 0;
    });
    const readNow = needed.filter((w) => stageOf(w.path) === "open" || needed.length <= FILL_BATCH);
    const bodies = new Map<string, string>();
    await parallel(readNow, async (w) => {
      bodies.set(w.blob, await gh.blob(w.blob));
    });

    // Links: each trailer commit's item files.
    const links: { number: number; sessionId: string; at: string }[] = [];
    for (const c of commits) {
      const trailers = sessionTrailers(c.message);
      if (!trailers.length) continue;
      for (const f of perCommit.get(c.sha) ?? []) {
        const ip = itemPath(f.filename) ?? (f.previousFilename ? itemPath(f.previousFilename) : null);
        if (!ip || !winners.has(ip.number)) continue;
        for (const sessionId of trailers) links.push({ number: ip.number, sessionId, at: c.at });
      }
    }

    const sql = this.deps.sql;
    this.deps.transaction(() => {
      for (const p of removed) sql.exec("DELETE FROM files WHERE path = ?", p);
      for (const f of changes) {
        const entry = files.get(f.filename);
        if (entry) sql.exec("INSERT INTO files (path, number, blob) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET number = excluded.number, blob = excluded.blob", f.filename, entry.number, entry.blob);
      }
      for (const n of numbers) {
        const w = winners.get(n);
        const prev = old.get(n);
        if (!w) {
          sql.exec("DELETE FROM items WHERE number = ?", n);
          sql.exec("DELETE FROM links WHERE number = ?", n);
          continue;
        }
        const ip = itemPath(w.path)!;
        const t = touch.get(w.path) ?? {};
        const changed = !prev || prev.blob !== w.blob || prev.path !== w.path;
        const body = bodies.get(w.blob) ?? (prev && prev.blob === w.blob && prev.parser > 0 ? prev.body : null);
        const parsed = body !== null ? parseItem(ip, body) : pendingParse(ip);
        const last = t.last ?? (complete ? undefined : newest);
        const updatedAt = changed ? (last?.at ?? prev?.updated_at ?? null) : (prev?.updated_at ?? null);
        let authorName = prev?.author_name ?? null;
        let authorEmail = prev?.author_email ?? null;
        let createdAt = prev?.created_at ?? null;
        if (!prev && t.added) {
          authorName = t.added.authorName;
          authorEmail = t.added.authorEmail;
          createdAt = t.added.at;
        }
        let closedAt = prev?.closed_at ?? null;
        let closedBy = prev?.closed_by ?? null;
        const wasOpen = !prev || stageOf(prev.path) === "open";
        if (ip.stage === "open") {
          closedAt = null;
          closedBy = null;
        } else if (wasOpen) {
          const closer = t.closed ?? (complete ? t.last : newest);
          closedAt = closer?.at ?? null;
          closedBy = closer ? closerName(closer) : null;
        }
        sql.exec(
          `INSERT INTO items (number, path, blob, body, parsed, parser, author_name, author_email, created_at, updated_at, closed_at, closed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (number) DO UPDATE SET path = excluded.path, blob = excluded.blob, body = excluded.body, parsed = excluded.parsed,
             parser = excluded.parser, author_name = excluded.author_name, author_email = excluded.author_email, created_at = excluded.created_at,
             updated_at = excluded.updated_at, closed_at = excluded.closed_at, closed_by = excluded.closed_by`,
          n,
          w.path,
          w.blob,
          body ?? "",
          JSON.stringify(parsed),
          body !== null ? PARSER_VERSION : 0,
          authorName,
          authorEmail,
          createdAt,
          updatedAt,
          closedAt,
          closedBy,
        );
      }
      for (const l of links) this.link(l.number, l.sessionId, l.at);
      this.setMeta("cursor", head);
      this.setMeta("as_of", this.now());
    });
    return "done";
  }

  private link(number: number, sessionId: string, at: string): void {
    this.deps.sql.exec(
      "INSERT INTO links (number, session_id, last_at) VALUES (?, ?, ?) ON CONFLICT (number, session_id) DO UPDATE SET last_at = MAX(last_at, excluded.last_at)",
      number,
      sessionId,
      at,
    );
  }

  // ------------------------------------------------------------------ walk

  /**
   * A few commits of the walk over `work/` then `done/`, newest first, within the quota: links,
   * authors (the commit that added the file), close dates and update dates the build could not know.
   */
  private async walkTick(): Promise<void> {
    const walk = this.metaJson<WalkState>("walk");
    const gh = this.client();
    if (!walk || !gh || !gh.spare()) return;
    const page = await gh.commits({ sha: walk.head, path: walk.dir, page: walk.page, perPage: WALK_PAGE });
    const slice = page.slice(walk.index, walk.index + WALK_COMMITS_PER_TICK);
    const details: { commit: CommitInfo; files: FileChange[] }[] = [];
    for (const c of slice) {
      if (!gh.spare()) break;
      details.push({ commit: c, files: (await gh.commit(c.sha)).files });
    }
    const sql = this.deps.sql;
    this.deps.transaction(() => {
      for (const { commit, files } of details) {
        const trailers = sessionTrailers(commit.message);
        for (const f of files) {
          const ip = itemPath(f.filename);
          const from = f.previousFilename ? itemPath(f.previousFilename) : null;
          const number = ip?.number ?? from?.number;
          if (number === undefined) continue;
          const row = sql.exec<ItemRow & Row>("SELECT * FROM items WHERE number = ?", number).toArray()[0];
          if (!row) continue;
          for (const sessionId of trailers) this.link(number, sessionId, commit.at);
          if (ip && (f.status === "added" || (f.status === "renamed" && !from)) && (row.created_at === null || commit.at < row.created_at)) {
            sql.exec("UPDATE items SET created_at = ?, author_name = ?, author_email = ? WHERE number = ?", commit.at, commit.authorName, commit.authorEmail, number);
          }
          if (ip?.stage === "closed" && row.closed_at === null && stageOf(row.path) === "closed" && (f.status === "added" || (f.status === "renamed" && from?.stage !== "closed"))) {
            sql.exec("UPDATE items SET closed_at = ?, closed_by = ? WHERE number = ?", commit.at, closerName(commit), number);
          }
          if (row.updated_at === null && f.filename === row.path) sql.exec("UPDATE items SET updated_at = ? WHERE number = ?", commit.at, number);
        }
      }
      let next: WalkState | null = { ...walk, index: walk.index + details.length };
      if (next.index >= page.length) {
        if (page.length >= WALK_PAGE) next = { ...walk, page: walk.page + 1, index: 0 };
        else next = walk.dir === "work" ? { head: walk.head, dir: "done", page: 1, index: 0 } : null;
      }
      this.setMeta("walk", next ? JSON.stringify(next) : null);
    });
  }

  // ------------------------------------------------------------------ pull requests

  /** At most every 5 minutes while read: the state of open items' pull requests not final yet. */
  private async refreshPulls(gh: WorkGitHub): Promise<void> {
    const now = this.now();
    if (now - this.metaNumber("read_at") >= READS_WINDOW_MS) return;
    if (now - this.metaNumber("pulls_at") < PULLS_EVERY_MS) return;
    if (!gh.spare("graphql")) return;
    const final = new Set(
      this.deps.sql.exec<{ url: string }>("SELECT url FROM pulls WHERE state IN ('merged', 'closed', 'unreadable')").toArray().map((r) => r.url),
    );
    const urls = new Set<string>();
    for (const r of this.deps.sql.exec<{ parsed: string }>("SELECT parsed FROM items WHERE path LIKE 'work/%' AND parser > 0").toArray()) {
      for (const url of (JSON.parse(r.parsed) as ParsedItem).pullRequests) if (pullOf(url) && !final.has(url)) urls.add(url);
    }
    if (!urls.size) return;
    this.setMeta("pulls_at", now);
    let states: Awaited<ReturnType<WorkGitHub["pulls"]>>;
    try {
      states = await gh.pulls([...urls].slice(0, PULLS_PER_QUERY));
    } catch (error) {
      // No pull request permission is not a problem with the repository: the links stay plain.
      if (error instanceof GitHubGone) return;
      throw error;
    }
    const at = new Date(now).toISOString();
    this.deps.transaction(() => {
      for (const [url, s] of states) {
        const state = s === "unreadable" ? "unreadable" : s.state;
        const title = s === "unreadable" ? null : s.title;
        this.deps.sql.exec(
          "INSERT INTO pulls (url, state, title, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET state = excluded.state, title = excluded.title, checked_at = excluded.checked_at",
          url,
          state,
          title,
          at,
        );
      }
    });
  }

  // ------------------------------------------------------------------ parser version

  /** A new parser version re-parses every stored body, with no GitHub call. */
  private reparse(): void {
    if (this.meta("parser_version") === String(PARSER_VERSION)) return;
    this.deps.transaction(() => {
      for (const r of this.deps.sql.exec<{ number: number; path: string; body: string } & Row>("SELECT number, path, body FROM items WHERE parser > 0").toArray()) {
        const ip = itemPath(r.path);
        if (ip) this.deps.sql.exec("UPDATE items SET parsed = ?, parser = ? WHERE number = ?", JSON.stringify(parseItem(ip, r.body)), PARSER_VERSION, r.number);
      }
      this.setMeta("parser_version", PARSER_VERSION);
    });
  }

  // ------------------------------------------------------------------ rows to items

  private indexed(rows: ItemRow[]): IndexedItem[] {
    const repo = this.repo();
    if (!rows.length || !repo) return [];
    const sql = this.deps.sql;
    const numbers = rows.map((r) => r.number);
    const marks = numbers.map(() => "?").join(",");
    const others = new Map<number, string[]>();
    for (const f of sql.exec<{ number: number; path: string } & Row>(`SELECT number, path FROM files WHERE number IN (${marks}) ORDER BY path`, ...numbers).toArray()) {
      others.set(f.number, [...(others.get(f.number) ?? []), f.path]);
    }
    const links = new Map<number, string[]>();
    for (const l of sql.exec<{ number: number; session_id: string } & Row>(`SELECT number, session_id FROM links WHERE number IN (${marks}) ORDER BY last_at DESC, session_id`, ...numbers).toArray()) {
      links.set(l.number, [...(links.get(l.number) ?? []), l.session_id]);
    }
    const pulls = new Map<string, { state: string | null; title: string | null }>();
    for (const p of sql.exec<{ url: string; state: string | null; title: string | null } & Row>("SELECT url, state, title FROM pulls").toArray()) pulls.set(p.url, p);
    return rows.map((r) => {
      const stage = stageOf(r.path);
      const parsed = JSON.parse(r.parsed) as ParsedItem;
      const duplicates = (others.get(r.number) ?? []).filter((p) => p !== r.path).map((p) => `Another file has number ${r.number}: ${p}`);
      return {
        number: r.number,
        stage,
        path: r.path,
        url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.branch.split("/").map(encodeURIComponent).join("/")}/${r.path.split("/").map(encodeURIComponent).join("/")}`,
        title: parsed.title,
        stateLine: parsed.stateLine,
        tags: parsed.tags,
        owner: parsed.owner,
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

/** Who closed: the commit's author, or null when a session made the commit (it says "closed in a session"). */
function closerName(c: CommitInfo): string | null {
  if (sessionTrailers(c.message).length) return null;
  return c.authorName.replace(/\s+via Computer$/i, "").trim() || null;
}

function refusal(problem: RepositoryProblem): string {
  switch (problem) {
    case "installation_removed":
      return "The GitHub installation is not connected to this organization.";
    case "installation_suspended":
      return "The GitHub installation is suspended.";
    case "repository_not_found":
      return "The repository does not exist or the installation does not grant it.";
    case "branch_not_found":
      return "The repository has no such branch.";
    case "access_denied":
      return "The installation cannot read the repository's contents.";
    case "github_app_not_configured":
      return "The GitHub App is not configured.";
  }
}

function encodeCursor(value: Record<string, number>): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeCursor(cursor: string, key: string): number | null {
  try {
    const text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const value = (JSON.parse(text) as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
