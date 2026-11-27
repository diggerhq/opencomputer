import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/durable/migrations.js";
import { sqlOf, type Sql } from "../src/durable/sql.js";
import { completeFolded, STEPS as ORG } from "../src/actors/org/schema.js";
import { STEPS as SLACK } from "../src/actors/slack/schema.js";
import { MIGRATIONS as SESSION_LOG, SCHEMA as SESSION_LOG_SCHEMA } from "../src/actors/session-log/schema.js";
import { ORG_STEPS, SESSION_LOG_MIGRATIONS, SLACK_STEPS } from "./fixtures/pre-collapse-steps.js";

/**
 * Org's, Slack's and SessionLog's storage steps were collapsed into one initial step each before
 * their first deploy. A fresh store ends with the same tables, columns, indexes and seeded rows
 * either way; only `_migrations.applied` differs (the number of steps).
 */

// Org is migrated on first use, so a fresh one is an empty store.
const ORGS = (env as unknown as { ORGS: DurableObjectNamespace }).ORGS;

type Step = (sql: Sql) => void;

/** Everything a store's schema is made of, and the rows the steps seed, `_migrations` aside. */
function shape(sql: Sql) {
  const objects = sql.exec<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name",
  );
  const tables = objects.filter((o) => o.type === "table").map((o) => o.name);
  return {
    tables: Object.fromEntries(
      tables.map((t) => [t, sql.exec(`PRAGMA table_info(${JSON.stringify(t)})`).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])]),
    ),
    // An index's text is not changed by later `ALTER TABLE`s, so it is compared as written (spaces aside).
    indexes: objects.filter((o) => o.type === "index").map((o) => [o.name, o.tbl_name, o.sql?.replace(/\s+/g, " ") ?? null]),
    others: objects.filter((o) => o.type !== "table" && o.type !== "index").map((o) => [o.type, o.name]),
    rows: Object.fromEntries(tables.filter((t) => t !== "_migrations").map((t) => [t, sql.exec(`SELECT * FROM ${JSON.stringify(t)}`)])),
  };
}

async function fresh(name: string, setup: (sql: Sql) => void) {
  return runInDurableObject(ORGS.getByName(name), (_instance, state) => {
    const sql = sqlOf(state.storage);
    setup(sql);
    return { shape: shape(sql), applied: sql.exec<{ applied: number }>("SELECT applied FROM _migrations WHERE k = 1")[0]?.applied };
  });
}

/** `before`'s steps, then `after`'s past its first (the steps added since the collapse), against `after` alone. */
async function same(name: string, before: Step[], after: Step[], first?: string) {
  const setup = (steps: Step[]) => (sql: Sql) => {
    if (first) sql.exec(first);
    migrate(sql, steps);
  };
  const since = after.slice(1);
  const old = await fresh(`${name}-before`, setup([...before, ...since]));
  const now = await fresh(`${name}-after`, setup(after));
  expect(old.applied).toBe(before.length + since.length);
  expect(now.applied).toBe(after.length);
  expect(Object.keys(now.shape.tables).length).toBeGreaterThan(1);
  expect(now.shape).toEqual(old.shape);
}

describe("storage steps collapsed before the first deploy", () => {
  it("Org: a fresh store has the schema and the carry-over alarms the eight steps gave it", () => same("collapse-org", ORG_STEPS, ORG));
  it("Org: a store that stopped before `slack_access_default` under the old steps is completed", async () => {
    // The first six of the eight: through `api_access_default`, as a development stack held it.
    const stopped = await fresh("collapse-org-stopped", (sql) => {
      migrate(sql, ORG_STEPS.slice(0, 6));
      migrate(sql, ORG);
      completeFolded(sql);
      completeFolded(sql);
    });
    const now = await fresh("collapse-org-whole", (sql) => {
      migrate(sql, ORG);
      completeFolded(sql);
    });
    expect(stopped.applied).toBe(6);
    expect(stopped.shape).toEqual(now.shape);
  });
  it("Slack: a fresh store has the schema the four steps gave it", () => same("collapse-slack", SLACK_STEPS, SLACK));
  it("SessionLog: on its production tables, the two steps and the one give the same schema", () =>
    same("collapse-session-log", SESSION_LOG_MIGRATIONS, SESSION_LOG, SESSION_LOG_SCHEMA));
});
