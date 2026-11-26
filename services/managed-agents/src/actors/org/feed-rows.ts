// Stored records as the feed's rows (spec 35.1).

import type { Origin, Person } from "../../api-objects/objects.js";
import type { PlaceRow, Row, SessionRow } from "./contract.js";
import type { Sql } from "../../durable/sql.js";
import { FEED_TABLES, type FeedTable } from "./schema.js";
import type { PlaceRec, Raw, SessionRec } from "./records.js";
import { iso, isoOrNull } from "./iso.js";
import { parse } from "./parse-json.js";
import { accessView } from "./audience.js";
import { attentionRef, emptySummary, statusOf, summaryOf } from "./summary.js";

const TIMES = new Set(["done_at", "brought_back_at", "earlier_at", "stand_at", "state_at", "at", "created_at"]);
const BOOLS = new Set(["keep", "blocked"]);
const JSONS: Partial<Record<FeedTable, string[]>> = {
  track: ["former_names"],
  result: ["meta"],
  proposal: ["args"],
  doc: ["spans"],
  pref: ["value"],
  op: ["args", "inverse", "fields"],
};
const camel = (column: string): string => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * A table's row as the feed sends it: `{ kind, id, version, audience, …fields in camelCase }`.
 * `kind` is the table; `id` the last key column; times are ISO strings; JSON columns are parsed;
 * `result`'s and `proposal`'s own `kind` column is sent as `type`. For `session` use `sessionRow`.
 */
export function feedRow(table: Exclude<FeedTable, "session">, raw: Raw): Row & { audience: string } {
  const keys = FEED_TABLES[table] as readonly string[];
  const out: Row & { audience: string } = { kind: table, id: String(raw[keys[keys.length - 1]!]), version: raw.version, audience: raw.audience };
  const jsons = JSONS[table] ?? [];
  for (const [column, value] of Object.entries(raw)) {
    if (column === "version" || column === "audience" || column === "id") continue;
    const name = column === "kind" ? "type" : camel(column);
    if (TIMES.has(column)) out[name] = isoOrNull(value as number | null);
    else if (BOOLS.has(column)) out[name] = value === 1;
    else if (jsons.includes(column)) out[name] = parse<unknown>(value as string | null, null);
    else out[name] = value;
  }
  return out;
}

export const placeRow = (rec: PlaceRec): PlaceRow & { audience: string } => feedRow("place", rec as unknown as Raw) as PlaceRow & { audience: string };

/** The `session` feed row and the API's object (spec 35.1, "A feed row"): Org's columns and the stored summary. */
export function sessionRow(sql: Sql, s: SessionRec): SessionRow & Row & { audience: string } {
  const summary = summaryOf(s);
  const place = sql.exec<{ done_at: number | null }>("SELECT done_at FROM place WHERE session_id = ?", s.id)[0];
  const owner: Person = { id: s.owner, name: s.owner_name ?? "", email: s.owner_email };
  const created = iso(s.created_at);
  return {
    kind: "session",
    version: s.version,
    audience: s.audience,
    id: s.id,
    title: s.title ?? summary.agentTitle ?? summary.title ?? "Untitled",
    status: statusOf(summary),
    archived: place !== undefined && place.done_at !== null,
    aside: s.aside !== null && s.aside === attentionRef(summary.asks),
    owner,
    origin: parse<Origin>(s.origin, { type: "api", client: null, slack: null }),
    settings: summary.settings ?? emptySummary({}, null).settings!,
    metadata: parse<Record<string, string>>(s.metadata, {}),
    activeTurnId: summary.activeTurnId,
    queued: summary.queued,
    asks: summary.asks,
    subagents: summary.subagents,
    lastTurn: summary.lastTurn,
    lastText: summary.lastText,
    context: summary.context,
    lastSeq: summary.lastSeq,
    logEpoch: summary.logEpoch,
    epochStartSeq: summary.epochStartSeq,
    createdAt: created,
    lastActiveAt: summary.lastActiveAt ?? created,
    syncedAt: summary.syncedAt,
    urls: { dashboard: null },
    access: accessView(s),
    titleBy: s.title_by,
    agentTitle: summary.agentTitle ?? null,
    lastAgentSeq: summary.lastAgentSeq ?? 0,
    blocked: s.blocked === 1,
    inbox: summary.inbox ?? [],
    machine: s.machine,
    role: s.role,
  };
}

/** The row of any feed table, by its stored record. */
export function rowOf(sql: Sql, table: FeedTable, raw: Raw): Row & { audience: string } {
  return table === "session" ? sessionRow(sql, raw as unknown as SessionRec) : feedRow(table, raw);
}

/** A row for a client: without `audience` (spec 35.1). */
export function forClient<T extends Row>(row: T): T {
  const { audience: _audience, ...rest } = row;
  return rest as T;
}
