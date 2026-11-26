/**
 * The rehearsal of deploy 1 (work 118; spec 43.1): one organization's Computer rows, read out of one
 * environment and loaded into a development stack, so Org's adoption and the Slack actor's import run over
 * real shapes before production runs them.
 *
 * Owns: which rows move, and the three operator routes' logic (`/internal/computer/rehearsal/dump`, `load`,
 * `migrate`). scripts/rehearsal.mjs is the caller.
 *
 * Invariants:
 *  - The dump only reads: SELECT over a closed list of tables, no bind, no id minted, no alarm set. An
 *    organization with no Computer object answers null.
 *  - No credential moves. Of `settings` only the Slack team's id, name, bot user and installer; never the bot
 *    token, the model key, `secrets`, `wire_keys`, the tunnel, nor the VM's row, alarms or billing segments:
 *    a copy must not drive a real machine or bill.
 *  - The load never runs in production (`BLUE_ENVIRONMENT`), and all three routes answer 503 unless the
 *    Worker has `REHEARSAL_KEY`, which production has only while an operator takes a dump.
 */
export const REHEARSAL_TABLES = [
  "settings",
  "sessions",
  "dispatches",
  "people",
  "slack_messages",
  "slack_queue",
  "join_requests",
  "notices",
  "billing_warnings",
  "session_context",
  "access_requests",
] as const;
export type RehearsalTable = (typeof REHEARSAL_TABLES)[number];

const SETTINGS = ["slackTeamId", "slackTeamName", "slackBotUserId", "slackInstallerUserId"];
const PAGE = 500;

export type RehearsalRow = Record<string, string | number | null>;

export function isRehearsalTable(table: unknown): table is RehearsalTable {
  return typeof table === "string" && (REHEARSAL_TABLES as readonly string[]).includes(table);
}

function plain(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new Error("rehearsal: a column holds bytes, which the dump does not carry");
}

/** A page of a table, in rowid order. `next` is the offset to ask for, null at the end. */
export function dumpTable(sql: SqlStorage, table: RehearsalTable, offset: number, limit: number): { rows: RehearsalRow[]; next: number | null } {
  const n = Math.max(1, Math.min(Number.isInteger(limit) ? limit : PAGE, PAGE));
  const from = Math.max(0, Number.isInteger(offset) ? offset : 0);
  const only = table === "settings" ? `WHERE key IN (${SETTINGS.map(() => "?").join(",")})` : "";
  const found = [...sql.exec(`SELECT * FROM ${table} ${only} ORDER BY rowid LIMIT ? OFFSET ?`, ...(only ? SETTINGS : []), n + 1, from)];
  const rows = found.slice(0, n).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])));
  return { rows, next: found.length > n ? from + n : null };
}

/** Writes rows as they were, by primary key; a column this version's table lacks is dropped. Returns how many. */
export function loadRows(sql: SqlStorage, table: RehearsalTable, rows: RehearsalRow[]): number {
  const columns = new Set([...sql.exec<{ name: string }>(`PRAGMA table_info(${table})`)].map((c) => c.name));
  let written = 0;
  for (const row of rows) {
    if (table === "settings" && !SETTINGS.includes(String(row.key))) continue;
    const keys = Object.keys(row).filter((k) => columns.has(k));
    if (!keys.length) continue;
    sql.exec(`INSERT OR REPLACE INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => plain(row[k])));
    written += 1;
  }
  return written;
}
