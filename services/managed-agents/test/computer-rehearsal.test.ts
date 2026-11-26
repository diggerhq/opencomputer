import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";

/**
 * The rehearsal's operator routes (src/computer/rehearsal.ts): a dump that only reads, a load that never
 * carries a credential, and the migration of spec 43.1 over what was loaded.
 */

const ORIGIN = "https://managedagents.test";
const ORG = "org_rehearsal";
const TEAM = "T0REHEARSE";

type Namespace = DurableObjectNamespace<ComputerDurableObject>;
const computer = (name: string) => (env as unknown as { COMPUTERS: Namespace }).COMPUTERS.getByName(name);
const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T, name = ORG) => runInDurableObject(computer(name), fn as never) as Promise<T>;

async function call(action: string, body: unknown, account = ORG, key: string | null = "test-rehearsal-key") {
  const response = await SELF.fetch(`${ORIGIN}/internal/computer/rehearsal/${action}?account_id=${account}`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const NOW = Date.now();
const thread = (n: number, sessionId: string | null) => ({
  runner_key: `${TEAM}:C0CH:${n}.000100`, team_id: TEAM, channel_id: "C0CH", thread_ts: `${n}.000100`, owner_id: "U0P1", title: `Thread ${n}`,
  created_at: NOW - n * 1000, updated_at: NOW, last_active_at: NOW, origin_type: "slack", session_id: sessionId, archived: 0, drivers: "*",
  a_column_from_another_version: "dropped",
});

describe("rehearsal routes", () => {
  it("refuses without the key, and a dump of an organization with no computer creates nothing", async () => {
    expect((await call("dump", { table: "sessions" }, ORG, null)).status).toBe(401);
    expect((await call("load", { table: "sessions", rows: [] }, ORG, "wrong")).status).toBe(401);
    expect((await call("dump", { table: "sessions" }, "org_nobody")).status).toBe(404);
    expect(await inside((_i, state) => [...state.storage.sql.exec("SELECT value FROM settings WHERE key = 'accountId'")].length, "org_nobody")).toBe(0);
    expect((await call("dump", { table: "secrets" })).status).toBe(400);
  });

  it("loads rows without credentials, dumps them back, and the migration adopts them", async () => {
    const settings = [
      { key: "slackTeamId", value: TEAM },
      { key: "slackBotToken", value: "sealed-elsewhere" },
      { key: "modelKeySealed", value: "sealed-elsewhere" },
    ];
    expect((await call("load", { table: "settings", rows: settings })).body).toEqual({ written: 1 });
    const sessions = [thread(1, "cs_0000000000000001"), thread(2, null)];
    expect((await call("load", { table: "sessions", rows: sessions })).body).toEqual({ written: 2 });
    expect((await call("load", { table: "people", rows: [{ slack_user_id: "U0P1", dir: "slack-U0P1", git_name: "P", git_email: "p@example.com", updated_at: NOW }] })).body).toEqual({ written: 1 });

    const dumped = await call("dump", { table: "sessions" });
    expect(dumped.body.next).toBeNull();
    expect(dumped.body.rows.map((r: any) => [r.runner_key, r.session_id])).toEqual(sessions.map((r) => [r.runner_key, r.session_id]));
    expect((await call("dump", { table: "settings" })).body.rows).toEqual([{ key: "slackTeamId", value: TEAM }]);
    // The dump minted nothing: the thread from before the API still has no id.
    expect(await inside((_i, state) => [...state.storage.sql.exec("SELECT COUNT(*) AS n FROM sessions WHERE session_id IS NULL")][0]!.n)).toBe(1);

    const migrated = await call("migrate", {});
    expect(migrated.status).toBe(200);
    expect(migrated.body.adopted).toBeTruthy();
    expect(migrated.body.imported).toBeTruthy();
    expect(await inside((_i, state) => [...state.storage.sql.exec("SELECT COUNT(*) AS n FROM sessions WHERE session_id IS NULL")][0]!.n)).toBe(0);
  });
});
