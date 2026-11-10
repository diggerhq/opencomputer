// The gateway's SQLite tables (work 045): sessions, people, hosts, Slack event
// de-duplication and the outbox for hosts that are offline. Everything the
// gateway must remember across a redeploy lives here; nothing per runner.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Delivery, SlackPerson, SessionReport, SlackSessionSpec, SessionStatus } from '../protocol.js';

export interface SessionRow {
  spec: SlackSessionSpec;
  host?: string;
  status?: SessionStatus;
  runnerVersion?: string;
  updated: number;
}

/** A message waiting for a host: replayed in order when one connects. */
export type Queued =
  | { t: 'deliver'; key: string; msg: Delivery }
  | { t: 'action'; key: string; promptId: string; value: string; userId: string };

const EVENT_TTL_MS = 60 * 60 * 1000;
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, spec TEXT NOT NULL, host TEXT, status TEXT,
        sdk_session_id TEXT, fork_path TEXT, runner_version TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS people (slack_user_id TEXT PRIMARY KEY, person TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  // ---- sessions

  session(key: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key) as any;
    if (!r) return undefined;
    // The columns the host reports are the truth; the spec carries them to the next deliver.
    const spec: SlackSessionSpec = { ...JSON.parse(r.spec), sdkSessionId: r.sdk_session_id ?? undefined, forkPath: r.fork_path ?? undefined };
    return { spec, host: r.host ?? undefined, status: r.status ?? undefined, runnerVersion: r.runner_version ?? undefined, updated: r.updated };
  }

  putSession(spec: SlackSessionSpec, host?: string) {
    this.db
      .prepare(
        `INSERT INTO sessions (key, spec, host, updated) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET spec = excluded.spec, host = COALESCE(excluded.host, host), updated = excluded.updated`,
      )
      .run(spec.key, JSON.stringify(spec), host ?? null, Date.now());
  }

  /** Sessions a host may have a runner for (not stopped), for pushing changed secrets. */
  liveSessions(): SessionRow[] {
    const keys = this.db.prepare("SELECT key FROM sessions WHERE status IN ('starting', 'idle', 'busy')").all() as { key: string }[];
    return keys.flatMap((r) => this.session(r.key) ?? []);
  }

  setHost(key: string, host: string) {
    this.db.prepare('UPDATE sessions SET host = ?, updated = ? WHERE key = ?').run(host, Date.now(), key);
  }

  /** A host's report: status, ids and paths, plus mode/model/effort/speed changes folded into the spec. */
  report(r: SessionReport, host: string) {
    const row = this.session(r.key);
    if (!row) return;
    const spec = { ...row.spec, ...(r.mode ? { mode: r.mode } : {}), ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), ...(r.speed ? { speed: r.speed } : {}) };
    this.db
      .prepare(
        `UPDATE sessions SET spec = ?, host = ?, status = ?, sdk_session_id = COALESCE(?, sdk_session_id),
         fork_path = COALESCE(?, fork_path), runner_version = COALESCE(?, runner_version), updated = ? WHERE key = ?`,
      )
      .run(JSON.stringify(spec), host, r.status, r.sdkSessionId ?? null, r.forkPath ?? null, r.runnerVersion ?? null, Date.now(), r.key);
  }

  // ---- people (the allowlist)

  person(slackUserId: string): SlackPerson | undefined {
    const r = this.db.prepare('SELECT person FROM people WHERE slack_user_id = ?').get(slackUserId) as any;
    return r ? JSON.parse(r.person) : undefined;
  }

  people(): SlackPerson[] {
    return (this.db.prepare('SELECT person FROM people').all() as any[]).map((r) => JSON.parse(r.person));
  }

  putPerson(p: SlackPerson) {
    this.db
      .prepare('INSERT INTO people (slack_user_id, person) VALUES (?, ?) ON CONFLICT DO UPDATE SET person = excluded.person')
      .run(p.slackUserId, JSON.stringify(p));
  }

  // ---- hosts

  /** The host id a token was issued to, or undefined. */
  hostForToken(token: string): string | undefined {
    const r = this.db.prepare('SELECT id FROM hosts WHERE token_hash = ?').get(hashToken(token)) as any;
    return r?.id;
  }

  putHost(id: string, token: string) {
    this.db
      .prepare('INSERT INTO hosts (id, token_hash) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash')
      .run(id, hashToken(token));
  }

  // ---- Slack event ids (Slack retries an event up to three times)

  /** True the first time an event id is seen within the TTL. */
  firstSeen(eventId: string): boolean {
    const now = Date.now();
    this.db.prepare('DELETE FROM events WHERE at < ?').run(now - EVENT_TTL_MS);
    return this.db.prepare('INSERT OR IGNORE INTO events (id, at) VALUES (?, ?)').run(eventId, now).changes > 0;
  }

  // ---- outbox

  enqueue(q: Queued) {
    this.db.prepare('INSERT INTO outbox (msg, at) VALUES (?, ?)').run(JSON.stringify(q), Date.now());
  }

  /** Everything queued and still fresh, oldest first; the outbox is emptied. */
  drain(): Queued[] {
    const rows = this.db.prepare('SELECT msg, at FROM outbox ORDER BY seq').all() as any[];
    this.db.exec('DELETE FROM outbox');
    return rows.filter((r) => r.at > Date.now() - OUTBOX_TTL_MS).map((r) => JSON.parse(r.msg));
  }
}
