// The organization's members as this Computer has seen them (CTO-37): every caller the edge
// asserted for this organization (dashboard, opc, API keys) and every session owner. Sharing a
// session with someone resolves them here, so a list names only members, by `usr_…`.
//
// Invariants:
//   - A row is written only from an authenticated call of this organization, or from a session's
//     owner columns; never from request input.
//   - Someone who left the organization stays listed but cannot reach the API any more (the edge
//     refuses them), so a stale row grants nothing.

import { memberId } from "./session-ids.js";

const MEMBER = /^usr_[0-9a-z]{1,64}$/;
const WORKOS_USER = /^user_[0-9A-Za-z]{1,64}$/;

export class ApiMembers {
  /** Members seen with this email in this object's lifetime: a repeat call writes nothing. */
  private readonly seen = new Map<string, string | null>();

  constructor(private readonly sql: SqlStorage, private readonly now: () => number) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS api_members (
        member TEXT PRIMARY KEY,
        email TEXT,
        name TEXT,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api_members_email ON api_members (email);
    `);
  }

  /** Records an asserted caller. */
  observe(member: string, email: string | null, name: string | null): void {
    const lower = email?.toLowerCase() ?? null;
    if (this.seen.has(member) && this.seen.get(member) === lower) return;
    this.seen.set(member, lower);
    this.sql.exec(
      `INSERT INTO api_members (member, email, name, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(member) DO UPDATE SET email = COALESCE(excluded.email, email), name = COALESCE(excluded.name, name), seen_at = excluded.seen_at`,
      member,
      lower,
      name,
      this.now(),
    );
  }

  private known(member: string): boolean {
    if ([...this.sql.exec("SELECT 1 FROM api_members WHERE member = ?", member)].length) return true;
    return [...this.sql.exec("SELECT 1 FROM sessions WHERE owner_user_id = ? LIMIT 1", member)].length > 0;
  }

  private byEmail(email: string): string | undefined {
    const lower = email.toLowerCase();
    const row = [...this.sql.exec<{ member: string }>("SELECT member FROM api_members WHERE email = ? ORDER BY seen_at DESC LIMIT 1", lower)][0]
      ?? [...this.sql.exec<{ member: string }>(
        "SELECT owner_user_id AS member FROM sessions WHERE lower(owner_email) = ? AND owner_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
        lower,
      )][0];
    return row?.member;
  }

  /** Each entry (member id, WorkOS user id or email) as a member id; the first that is not a known member fails. */
  async resolve(entries: readonly string[]): Promise<{ members: string[] } | { unknown: string }> {
    const members: string[] = [];
    for (const entry of entries) {
      const id = MEMBER.test(entry) ? entry : WORKOS_USER.test(entry) ? await memberId(entry) : entry.includes("@") ? this.byEmail(entry) : undefined;
      if (!id || !this.known(id)) return { unknown: entry };
      members.push(id);
    }
    return { members };
  }
}
