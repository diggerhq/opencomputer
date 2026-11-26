// The connect-code routing record (work 082, CLI connect; work 097, 6b): the
// public side of connect codes. A code's hash routes to its organization
// through a `computer-connect-codes:<x>` object; routes.ts looks the hash up,
// the organization's object (connect-codes.ts, behind ModelAccess) decides.

import { sha256Hex } from "./crypto.js";
import type { AgentError } from "./model-access.js";

export const CONNECT_CODE_PREFIX = "oc_";
/** Crockford base32: no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;
/** Longer than any code someone could mean: refused unread. */
const CONNECT_CODE_MAX_INPUT = 64;

export const CONNECT_CODE_INVALID = {
  status: 401,
  code: "computer_connect_code_invalid",
  message: "That connect code is not valid. Get a new one from the dashboard.",
} as const satisfies AgentError;

/** A fresh code: `oc_` + 16 Crockford base32 characters from 80 random bits. */
export function newConnectCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array((CODE_LENGTH * 5) / 8));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${CONNECT_CODE_PREFIX}${out}`;
}

/**
 * What someone typed, as the code it means (`oc_` + 16 uppercase Crockford
 * characters), or null: any case, surrounding spaces, I/L for 1 and O for 0.
 */
export function normalizeConnectCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > CONNECT_CODE_MAX_INPUT) return null;
  const trimmed = input.trim();
  if (trimmed.slice(0, CONNECT_CODE_PREFIX.length).toLowerCase() !== CONNECT_CODE_PREFIX) return null;
  const body = trimmed.slice(CONNECT_CODE_PREFIX.length).toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(body) ? `${CONNECT_CODE_PREFIX}${body}` : null;
}

/** The SHA-256 (hex) a normalized code is stored and routed by. */
export const connectCodeHash = (code: string) => sha256Hex(code);

/** The routing object that knows which organization a code (by hash) belongs to. */
export const CONNECT_CODE_INDEX_PREFIX = "computer-connect-codes:";
export const connectCodeIndexName = (hash: string) => `${CONNECT_CODE_INDEX_PREFIX}${hash[0]}`;

/**
 * The routing record (in a `computer-connect-codes:<x>` object): hash →
 * organization, until the code expires. Only routes; the organization's
 * object decides. Expired records go with the next write (mint, unroute);
 * the lookup, reached by anyone with a well-formed code, is a read and
 * ignores them, so the public route costs this object no write.
 */
export class ConnectCodeIndex {
  private ready = false;
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number = Date.now,
  ) {}

  private table(): SqlStorage {
    if (!this.ready) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS connect_code_index (
        code_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
      this.ready = true;
    }
    return this.sql;
  }

  private swept(): SqlStorage {
    this.table().exec("DELETE FROM connect_code_index WHERE expires_at <= ?", this.now());
    return this.sql;
  }

  put(hash: string, accountId: string, expiresAt: number): void {
    this.swept().exec("INSERT OR REPLACE INTO connect_code_index (code_hash, account_id, expires_at) VALUES (?, ?, ?)", hash, accountId, expiresAt);
  }

  accountOf(hash: string): string | null {
    return [...this.table().exec<{ account_id: string }>("SELECT account_id FROM connect_code_index WHERE code_hash = ? AND expires_at > ?", hash, this.now())][0]?.account_id ?? null;
  }

  forget(hash: string): void {
    this.swept().exec("DELETE FROM connect_code_index WHERE code_hash = ?", hash);
  }
}

/** The connect-code log line: never the code, its hash, or a token. */
export function logConnectCode(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", event: "computer.agent_connect_code", ...fields }));
}
