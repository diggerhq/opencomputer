// Encrypted secret store in the gateway's SQLite database (work 045, item S3).
// Owned by S3. Key: SP_STORE_KEY (a deployment secret). Values set by hand
// (environment) win over stored ones, so laptop mode keeps working from .env.
//
// Rows: secrets(name, iv, tag, data), AES-256-GCM with the name as associated
// data (a row copied under another name does not decrypt). The AES key is
// HKDF-SHA256 of SP_STORE_KEY; generate one with `openssl rand -hex 32`.
// Setting a secret to '' deletes it.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface Secrets {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

/** Every name the setup flow and the gateway read or write. */
export const SECRET_NAMES = [
  'SLACK_APP_ID',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
  'SLACK_STATE_SECRET',
  'SLACK_CONFIG_TOKEN',
  'SLACK_CONFIG_TOKEN_EXP',
  'SLACK_CONFIG_REFRESH_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_BOT_USER_ID',
  'SLACK_BOT_ID',
  'SLACK_TEAM_ID',
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_OWNER',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_INSTALLATION_ID',
  'GITHUB_INSTALLATION_ACCOUNT',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

/** Store details beyond the Secrets interface (setup page status, host tokens). */
export interface SecretStore extends Secrets {
  db: DatabaseSync;
  /** Where get(name) would answer from. */
  source(name: string): 'env' | 'store' | undefined;
  /** True when SP_STORE_KEY is set, i.e. set() can work. */
  writable: boolean;
}

/** An AES-256 key from SP_STORE_KEY; `info` separates the tables that use it. */
export function deriveKey(secret: string, info = 'secret-store v1'): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'slack-presence', info, 32));
}

const dbs = new WeakMap<Secrets, DatabaseSync>();

/** The database behind a store returned by openSecrets (for host tokens). */
export function secretsDb(secrets: Secrets): DatabaseSync | undefined {
  return dbs.get(secrets);
}

export function openSecrets(db: DatabaseSync, key = process.env.SP_STORE_KEY): SecretStore {
  db.exec('CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, iv BLOB NOT NULL, tag BLOB NOT NULL, data BLOB NOT NULL)');
  const aes = key ? deriveKey(key) : undefined;
  const select = db.prepare('SELECT iv, tag, data FROM secrets WHERE name = ?');
  const upsert = db.prepare(
    'INSERT INTO secrets (name, iv, tag, data) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data',
  );
  const remove = db.prepare('DELETE FROM secrets WHERE name = ?');

  const fromEnv = (name: string) => {
    const v = process.env[name];
    return v ? v : undefined;
  };

  function stored(name: string): string | undefined {
    const row = select.get(name) as { iv: Uint8Array; tag: Uint8Array; data: Uint8Array } | undefined;
    if (!row) return undefined;
    if (!aes) throw new Error(`secret store: ${name} is stored encrypted but SP_STORE_KEY is not set`);
    try {
      const d = createDecipheriv('aes-256-gcm', aes, row.iv);
      d.setAAD(Buffer.from(name));
      d.setAuthTag(row.tag);
      return Buffer.concat([d.update(row.data), d.final()]).toString('utf8');
    } catch {
      throw new Error(`secret store: cannot decrypt ${name} (wrong SP_STORE_KEY, or the row was tampered with)`);
    }
  }

  const store: SecretStore = {
    db,
    writable: !!aes,
    get: (name) => fromEnv(name) ?? stored(name),
    source: (name) => (fromEnv(name) ? 'env' : select.get(name) ? 'store' : undefined),
    set(name, value) {
      if (!value) {
        remove.run(name);
        return;
      }
      if (!aes) throw new Error(`secret store: cannot save ${name}: SP_STORE_KEY is not set (generate one with \`openssl rand -hex 32\`)`);
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', aes, iv);
      c.setAAD(Buffer.from(name));
      const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      upsert.run(name, iv, c.getAuthTag(), data);
    },
  };
  dbs.set(store, db);
  return store;
}
