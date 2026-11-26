// Host tokens (work 045, item S3): bearer tokens a host agent presents on the
// gateway's WebSocket upgrade. Only a SHA-256 of each token is stored; the
// token itself is shown once on the setup page.

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const PREFIX = 'sph_';

function init(db: DatabaseSync) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS host_tokens (hash TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)',
  );
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Create a host token. Returns the token; it cannot be recovered later. */
export function issueHostToken(db: DatabaseSync, label = 'host'): string {
  init(db);
  const token = PREFIX + randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO host_tokens (hash, label, created_at) VALUES (?, ?, ?)').run(hash(token), label, new Date().toISOString());
  return token;
}

/** The token's label if it is valid (and records its use), else undefined. */
export function checkHostToken(db: DatabaseSync, token: string | undefined): string | undefined {
  if (!token?.startsWith(PREFIX)) return undefined;
  init(db);
  const h = hash(token);
  // Lookup by hash: the hash is not secret-dependent in a way a timing attack can exploit.
  const row = db.prepare('SELECT label FROM host_tokens WHERE hash = ?').get(h) as { label: string } | undefined;
  if (!row) return undefined;
  db.prepare('UPDATE host_tokens SET last_used_at = ? WHERE hash = ?').run(new Date().toISOString(), h);
  return row.label;
}

export interface HostTokenInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** Issued tokens; `id` is a short hash prefix, usable with revokeHostToken. */
export function listHostTokens(db: DatabaseSync): HostTokenInfo[] {
  init(db);
  return (db.prepare('SELECT hash, label, created_at, last_used_at FROM host_tokens ORDER BY created_at').all() as any[]).map((r) => ({
    id: String(r.hash).slice(0, 12),
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
  }));
}

export function revokeHostToken(db: DatabaseSync, id: string): boolean {
  init(db);
  if (!/^[0-9a-f]{12}$/.test(id)) return false;
  return Number(db.prepare("DELETE FROM host_tokens WHERE substr(hash, 1, 12) = ?").run(id).changes) > 0;
}
