// Org as a client sees it: the rows, the one version counter, the feed read (section 37.1), the
// occurrences and the list reads. Mutations are in mutations.ts.

import { checksum } from "../sum.js";
import type { DocRow, FeedFrame, PlaceRow, ResultRow, Row, RowKind, RowOf, SessionRow, TrackRow } from "../types.js";
import type { Review } from "../review.js";
import { ROW_KINDS } from "../types.js";
import { clone, Refusal, type Ctx } from "./ctx.js";

export interface Gone {
  kind: string;
  id: string;
  audience: string;
  version: number;
  at: number;
}

export interface Occurrence {
  n: string;
  key: string;
  kind: string;
  sessionId: string | null;
  trackId: string | null;
  by: string | null;
  at: string;
}

/** What Org publishes to Live after a transaction (section 40.4). */
export interface Published {
  from: number;
  to: number;
  rows: Row[];
  gone: Gone[];
}

export const MAX_ROWS = 2000;
const DAY = 86_400_000;

export const feedCursor = (v: number): string => `f1.${v}`;
export function parseFeedCursor(s: string): number | null {
  const m = /^f1\.(\d+)$/.exec(s);
  return m ? Number(m[1]) : null;
}

export class Org {
  version = 0;
  floor = 0;
  tables = new Map<RowKind, Map<string, Row>>();
  gone: Gone[] = [];
  /** A member's mutation replies by `Idempotency-Key`, with the request's hash. */
  idem = new Map<string, { hash: string; reply: { status: number; body: unknown } }>();
  occurrences: Occurrence[] = [];
  reviews = new Map<string, Review>();
  docRevs = new Map<string, { trackId: string; rev: number; by: string; at: number; text: string }[]>();
  mismatches: unknown[] = [];
  /** A pull request's unified diff, by result id. */
  diffs = new Map<string, string>();

  private depth = 0;
  private dirty = new Set<Row>();
  private removed: { kind: string; id: string; audience: string }[] = [];

  constructor(private ctx: Ctx) {
    for (const k of ROW_KINDS) this.tables.set(k, new Map());
  }

  // ---------- rows

  get<K extends RowKind>(kind: K, id: string): RowOf<K> | undefined {
    return this.tables.get(kind)!.get(id) as RowOf<K> | undefined;
  }

  need<K extends RowKind>(kind: K, id: string): RowOf<K> {
    const r = typeof id === "string" ? this.get(kind, id) : undefined;
    if (!r) throw new Refusal("not_found", `no such ${kind}`);
    return r;
  }

  all<K extends RowKind>(kind: K): RowOf<K>[] {
    return [...this.tables.get(kind)!.values()] as RowOf<K>[];
  }

  audience(row: Row): string {
    switch (row.kind) {
      case "track":
        return `member:${row.owner}`;
      case "doc":
        return `member:${this.get("track", row.trackId)?.owner ?? this.ctx.principal.subject}`;
      case "session":
        return row.role ? `member:${row.owner.id}` : "org";
      case "read":
      case "pref":
        return `member:${row.member}`;
      default:
        return "org";
    }
  }

  /** The list is one member: they hold `org` and their own `member:`. */
  visible(audience: string): boolean {
    return audience === "org" || audience === `member:${this.ctx.principal.subject}`;
  }

  /** One transaction: every row touched inside is stamped with one new version, then published. */
  tx<T>(fn: () => T): T {
    this.depth++;
    try {
      return fn();
    } finally {
      if (--this.depth === 0) this.commit();
    }
  }

  touch(row: Row): void {
    this.tx(() => void this.dirty.add(row));
  }

  put<R extends Row>(row: R): R {
    this.tables.get(row.kind)!.set(row.id, row);
    this.touch(row);
    return row;
  }

  remove(kind: RowKind, id: string): void {
    const row = this.get(kind, id);
    if (!row) return;
    this.tx(() => {
      this.removed.push({ kind, id, audience: this.audience(row) });
      this.tables.get(kind)!.delete(id);
      this.dirty.delete(row);
    });
  }

  private commit(): void {
    if (!this.dirty.size && !this.removed.length) return;
    const from = this.version;
    const to = ++this.version;
    const rows = [...this.dirty];
    for (const r of rows) r.version = to;
    const gone = this.removed.map((g) => ({ ...g, version: to, at: this.ctx.now() }));
    this.gone.push(...gone);
    this.dirty = new Set();
    this.removed = [];
    this.ctx.live.publishFeed({ from, to, rows, gone });
  }

  // ---------- derived

  place(sid: string): PlaceRow | undefined {
    return this.get("place", sid);
  }

  threadsOf(tid: string): PlaceRow[] {
    return this.all("place").filter((p) => p.trackId === tid);
  }

  trackOfAgent(sid: string): TrackRow | undefined {
    return this.all("track").find((t) => t.agentSession === sid);
  }

  /** The thread a row belongs to, for "rows of an Earlier thread". */
  private threadOf(row: Row): string | null {
    switch (row.kind) {
      case "session":
      case "place":
        return row.id;
      case "result":
        return row.sessionId;
      case "proposal":
        return row.target;
      case "op":
        return row.sessionId;
      default:
        return null;
    }
  }

  private inSnapshot(row: Row): boolean {
    const sid = this.threadOf(row);
    if (sid && this.place(sid)?.earlierAt != null) return false;
    if (row.kind === "op" && row.at < this.ctx.now() - DAY) return false;
    return true;
  }

  /** `blocked` (section 35.1) and `archived`, from the three facts they follow. */
  sync(sid: string): void {
    const s = this.get("session", sid);
    if (!s) return;
    const p = this.place(sid);
    const blocked = s.asks.some((a) => a.status === "open") || s.lastTurn?.status === "failed" || !!p?.attention;
    const archived = p?.doneAt != null;
    if (blocked !== s.blocked || archived !== s.archived) {
      s.blocked = blocked;
      s.archived = archived;
      this.touch(s);
    }
  }

  occur(kind: string, key: string, o: { sessionId?: string | null; trackId?: string | null; by?: string | null }): void {
    if (this.occurrences.some((e) => e.key === key)) return;
    this.occurrences.push({
      n: String(this.occurrences.length + 1),
      key,
      kind,
      sessionId: o.sessionId ?? null,
      trackId: o.trackId ?? (o.sessionId ? (this.place(o.sessionId)?.trackId ?? null) : null),
      by: o.by ?? null,
      at: this.ctx.iso(),
    });
  }

  // ---------- the feed read

  private wanted(kinds: string[] | null): (r: Row) => boolean {
    const set = kinds && new Set(kinds);
    return (r) => (!set || set.has(r.kind)) && this.visible(this.audience(r));
  }

  private rowsSorted(): Row[] {
    const rows: Row[] = [];
    for (const t of this.tables.values()) rows.push(...t.values());
    return rows.sort((a, b) => a.version - b.version);
  }

  snapshotRows(kinds: string[] | null): Row[] {
    const want = this.wanted(kinds);
    return this.rowsSorted().filter((r) => want(r) && this.inSnapshot(r));
  }

  counts(): NonNullable<FeedFrame["counts"]> {
    const trackEarlier: Record<string, number> = {};
    let earlier = 0;
    for (const p of this.all("place")) {
      if (p.earlierAt == null) continue;
      if (p.trackId) trackEarlier[p.trackId] = (trackEarlier[p.trackId] ?? 0) + 1;
      else earlier++;
    }
    return { earlier, trackEarlier };
  }

  /** Throws `Refusal('reset')` for a cursor below the floor or one that does not parse. */
  async feed(q: { after: string | null; kinds: string[] | null; sum: boolean }): Promise<FeedFrame> {
    const p = this.ctx.principal;
    let after: number | null = null;
    if (q.after != null) {
      after = parseFeedCursor(q.after);
      if (after == null || after < this.floor || after > this.version) throw new Refusal("reset", "the cursor's position no longer exists", { cursor: null });
    }
    const head = this.version;
    let rows = after == null ? this.snapshotRows(q.kinds) : this.rowsSorted().filter((r) => r.version > after! && this.wanted(q.kinds)(r));
    let to = head;
    let more = false;
    if (rows.length > MAX_ROWS) {
      // A version is never split across replies: the rows of the last version sent all go.
      let end = MAX_ROWS;
      while (end < rows.length && rows[end].version === rows[end - 1].version) end++;
      if (end < rows.length) {
        rows = rows.slice(0, end);
        to = rows[end - 1].version;
        more = true;
      }
    }
    const frame: FeedFrame = {
      protocol: 1,
      org: p.org,
      subject: p.subject,
      from: after == null ? null : feedCursor(after),
      to: feedCursor(to),
      more,
      rows: clone(rows),
      gone: after == null ? [] : this.gone.filter((g) => g.version > after! && g.version <= to && this.visible(g.audience)).map((g) => ({ kind: g.kind, id: g.id })),
      version: to,
    };
    if (after == null) frame.counts = this.counts();
    if (q.sum) frame.sum = await checksum(this.snapshotRows(null).filter((r) => r.version <= to));
    return frame;
  }

  // ---------- the other reads

  private threadRows(sid: string): (SessionRow | PlaceRow | ResultRow)[] {
    const s = this.get("session", sid);
    const p = this.place(sid);
    if (!s || !p) return [];
    return [s, p, ...this.all("result").filter((r) => r.sessionId === sid)];
  }

  /** `GET /work/threads?earlier&track&before&limit`: newest first; `before` and `next` are `p1.<offset>`. */
  threads(q: { earlier: boolean; track: string | null; before: string | null; limit: number }): { protocol: 1; rows: Row[]; next: string | null } {
    const at = (p: PlaceRow) => p.earlierAt ?? p.position;
    const places = this.all("place")
      .filter((p) => (p.earlierAt != null) === q.earlier && p.trackId === q.track)
      .sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : 1));
    let off = 0;
    if (q.before != null) {
      const m = /^p1\.(\d+)$/.exec(q.before);
      if (!m) throw new Refusal("reset", "the cursor does not parse", { cursor: null });
      off = Number(m[1]);
    }
    const page = places.slice(off, off + q.limit);
    return { protocol: 1, rows: clone(page.flatMap((p) => this.threadRows(p.id))), next: off + q.limit < places.length ? `p1.${off + q.limit}` : null };
  }

  markOf(sid: string): "blocked" | "ready" | "working" | "new" | "done" | "" {
    const s = this.get("session", sid);
    const p = this.place(sid);
    if (!s) return "";
    if (p?.doneAt != null) return "done";
    if (s.blocked) return "blocked";
    const read = this.get("read", `${this.ctx.principal.subject}:${sid}`)?.readSeq ?? 0;
    if ((p?.readySeq != null && p.readySeq > read) || this.all("proposal").some((x) => x.target === sid && x.state === "open")) return "ready";
    if (s.status === "running" || s.status === "starting") return "working";
    return s.lastAgentSeq > read ? "new" : "";
  }

  /** `GET /work/overview`: names, stands, marks and results; no conversation text. */
  overview(): unknown {
    const thread = (p: PlaceRow) => {
      const s = this.get("session", p.id)!;
      return {
        id: p.id,
        title: s.title,
        mark: this.markOf(p.id),
        outcome: p.outcome,
        earlier: p.earlierAt != null,
        what: p.attention ?? p.readyWhat,
        results: this.all("result")
          .filter((r) => r.sessionId === p.id)
          .map((r) => ({ id: r.id, type: r.type, title: r.title, ref: r.ref, state: r.state })),
      };
    };
    const byPos = (a: { position: number }, b: { position: number }) => b.position - a.position;
    return {
      protocol: 1,
      tracks: this.all("track")
        .sort(byPos)
        .map((t) => ({ id: t.id, name: t.name, stand: t.stand, done: t.doneAt != null, outcome: t.outcome, threads: this.threadsOf(t.id).sort(byPos).map(thread) })),
      threads: this.all("place")
        .filter((p) => !p.trackId)
        .sort(byPos)
        .map(thread),
    };
  }

  /** `GET /work/search?q&limit`: every word of `q`, case-folded, in a title, a name, a stand or a result's title. */
  search(q: string, limit: number, formerTitles: (sid: string) => string[]): { protocol: 1; rows: Row[] } {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (...texts: (string | null | undefined)[]) => {
      const hay = texts.filter(Boolean).join("\n").toLowerCase();
      return words.length > 0 && words.every((w) => hay.includes(w));
    };
    const rows: Row[] = [];
    const seen = new Set<Row>();
    const add = (...rs: (Row | undefined)[]) => {
      for (const r of rs) if (r && !seen.has(r) && this.visible(this.audience(r))) (seen.add(r), rows.push(r));
    };
    for (const t of this.all("track")) if (hit(t.name, ...t.formerNames, t.stand)) add(t);
    for (const s of this.all("session")) if (!s.role && hit(s.title, ...formerTitles(s.id))) add(s, this.place(s.id));
    for (const r of this.all("result")) if (hit(r.title)) add(r, this.get("session", r.sessionId), this.place(r.sessionId));
    return { protocol: 1, rows: clone(rows.slice(0, limit)) };
  }

  doc(tid: string): DocRow | undefined {
    return this.get("doc", tid);
  }

  /** The hourly alarm (section 40.8). */
  age(): void {
    const now = this.ctx.now();
    const WEEK = 7 * DAY;
    this.tx(() => {
      for (const p of this.all("place")) {
        if (p.earlierAt != null || p.keep) continue;
        const s = this.get("session", p.id);
        if (!s || s.blocked || s.status === "running" || s.status === "starting") continue;
        if (this.all("proposal").some((x) => x.target === p.id && x.state === "open")) continue;
        const read = this.get("read", `${s.owner.id}:${p.id}`)?.readSeq ?? 0;
        if (read < s.lastAgentSeq) continue;
        if (Date.parse(s.lastActiveAt) > now - WEEK || (p.broughtBackAt ?? 0) > now - WEEK) continue;
        p.earlierAt = now;
        this.touch(p);
      }
      for (const op of this.all("op")) if (op.at < now - 30 * DAY) this.remove("op", op.id);
    });
    const old = this.gone.filter((g) => g.at < now - 30 * DAY);
    if (old.length) {
      this.floor = Math.max(this.floor, ...old.map((g) => g.version));
      this.gone = this.gone.filter((g) => g.at >= now - 30 * DAY);
    }
  }
}
