// Secrets people give their sessions (work 046), kept by the gateway in its
// SQLite database and encrypted like the installation store: AES-256-GCM with
// a key derived from SP_STORE_KEY. The gateway is the copy of record; hosts
// get values in memory, with each delivery and when they change.
//
//   scope    applies to                    owner
//   session  one thread's session          the session key
//   user     every session a person owns   their Slack user id
//   workspace every session                ''
//
// A session gets the union; on a name clash the narrowest scope wins. Each
// row's scope, owner and name are its associated data, so a row copied under
// another name or scope does not decrypt. Session rows are deleted once their
// session has been inactive for SESSION_TTL_MS. Variables (`!var`, not
// secret) are rows with `variable` set, stored the same way; in one scope a
// name is one or the other.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretScope, SessionSecret } from '../protocol.js';
import { deriveKey } from '../setup/secrets.js';
import { log } from '../log.js';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const MAX_VALUE = 64 * 1024;

export interface SecretMeta {
  scope: SecretScope;
  owner: string;
  name: string;
  file: boolean;
  variable: boolean;
  setBy: string;
  updated: number;
}

interface MetaRow {
  scope: SecretScope;
  owner: string;
  name: string;
  file: number;
  variable: number;
  set_by: string;
  updated: number;
}
interface SecretRow extends Pick<MetaRow, 'scope' | 'owner' | 'name' | 'file' | 'variable'> {
  iv: Uint8Array;
  tag: Uint8Array;
  data: Uint8Array;
}

const RANK: Record<SecretScope, number> = { workspace: 0, user: 1, session: 2 };

export class Vault {
  readonly writable: boolean;
  private aes?: Buffer;

  constructor(
    private db: DatabaseSync,
    key = process.env.SP_STORE_KEY,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_secrets (
      scope TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, file INTEGER NOT NULL,
      iv BLOB NOT NULL, tag BLOB NOT NULL, data BLOB NOT NULL, set_by TEXT NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (scope, owner, name))`);
    if (!(db.prepare('PRAGMA table_info(user_secrets)').all() as { name: string }[]).some((c) => c.name === 'variable'))
      db.exec('ALTER TABLE user_secrets ADD COLUMN variable INTEGER NOT NULL DEFAULT 0');
    this.aes = key ? deriveKey(key, 'user-secrets v1') : undefined;
    this.writable = !!this.aes;
  }

  private static aad = (scope: string, owner: string, name: string) => Buffer.from(`${scope}\0${owner}\0${name}`);

  set(scope: SecretScope, owner: string, name: string, value: string, file: boolean, setBy: string, variable = false) {
    if (!this.aes) throw new Error('secrets need SP_STORE_KEY on the gateway');
    if (!value) throw new Error('empty value');
    if (Buffer.byteLength(value) > MAX_VALUE) throw new Error(`value too large (limit ${MAX_VALUE} bytes)`);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.aes, iv);
    c.setAAD(Vault.aad(scope, owner, name));
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    this.db
      .prepare(
        `INSERT INTO user_secrets (scope, owner, name, file, variable, iv, tag, data, set_by, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, owner, name) DO UPDATE SET file = excluded.file, variable = excluded.variable, iv = excluded.iv,
         tag = excluded.tag, data = excluded.data, set_by = excluded.set_by, updated = excluded.updated`,
      )
      .run(scope, owner, name, file ? 1 : 0, variable ? 1 : 0, iv, c.getAuthTag(), data, setBy, Date.now());
  }

  /** True when there was such a secret. */
  delete(scope: SecretScope, owner: string, name: string): boolean {
    return this.db.prepare('DELETE FROM user_secrets WHERE scope = ? AND owner = ? AND name = ?').run(scope, owner, name).changes > 0;
  }

  /** Names and metadata (never values) for the given scopes, narrowest first. */
  list(scopes: { scope: SecretScope; owner: string }[]): SecretMeta[] {
    const q = this.db.prepare('SELECT scope, owner, name, file, variable, set_by, updated FROM user_secrets WHERE scope = ? AND owner = ? ORDER BY name');
    return scopes
      .flatMap(({ scope, owner }) => q.all(scope, owner) as unknown as MetaRow[])
      .map((r) => ({ scope: r.scope, owner: r.owner, name: r.name, file: !!r.file, variable: !!r.variable, setBy: r.set_by, updated: r.updated }))
      .sort((a, b) => RANK[b.scope as SecretScope] - RANK[a.scope as SecretScope]);
  }

  /** Variables (with their values: they are not secret) for the given scopes, narrowest first. */
  variables(scopes: { scope: SecretScope; owner: string }[]): (SecretMeta & { value: string })[] {
    const q = this.db.prepare('SELECT iv, tag, data FROM user_secrets WHERE scope = ? AND owner = ? AND name = ?');
    return this.list(scopes).flatMap((m) => {
      if (!m.variable) return [];
      const value = this.open({ ...m, file: 0, variable: 1, ...(q.get(m.scope, m.owner, m.name) as unknown as Pick<SecretRow, 'iv' | 'tag' | 'data'>) });
      return value === undefined ? [] : [{ ...m, value }];
    });
  }

  private open(r: SecretRow): string | undefined {
    if (!this.aes) return undefined;
    try {
      const d = createDecipheriv('aes-256-gcm', this.aes, r.iv);
      d.setAAD(Vault.aad(r.scope, r.owner, r.name));
      d.setAuthTag(r.tag);
      return Buffer.concat([d.update(r.data), d.final()]).toString('utf8');
    } catch {
      log.warn(`secret ${r.scope}/${r.name} does not decrypt (wrong SP_STORE_KEY, or the row was tampered with); skipped`);
    }
  }

  /** Every secret a session gets, narrowest scope winning per name. Rows that do not decrypt are skipped. */
  forSession(sessionKey: string, ownerUserId: string): SessionSecret[] {
    if (!this.aes) return [];
    const rows = this.db
      .prepare(
        `SELECT scope, owner, name, file, variable, iv, tag, data FROM user_secrets
         WHERE (scope = 'workspace' AND owner = '') OR (scope = 'user' AND owner = ?) OR (scope = 'session' AND owner = ?)`,
      )
      .all(ownerUserId, sessionKey) as unknown as SecretRow[];
    const out = new Map<string, SessionSecret>();
    for (const r of rows.sort((a, b) => RANK[a.scope as SecretScope] - RANK[b.scope as SecretScope])) {
      const value = this.open(r);
      if (value !== undefined) out.set(r.name, { name: r.name, value, scope: r.scope, ...(r.file ? { file: true } : {}), ...(r.variable ? { variable: true } : {}) });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Delete session secrets whose session is gone or inactive for SESSION_TTL_MS; returns how many. */
  purge(now = Date.now()): number {
    return this.db
      .prepare(
        `DELETE FROM user_secrets WHERE scope = 'session'
         AND owner NOT IN (SELECT key FROM sessions WHERE updated > ?)`,
      )
      .run(now - SESSION_TTL_MS).changes as number;
  }
}
