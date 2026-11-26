import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { routeComputerApi } from "../src/computer/api-http.js";
import type { RequestIdentity } from "../src/edge/auth.js";

/**
 * Lazy adoption (spec 43.1, rehearsal check 3.1): an organization nobody has touched since the deploy,
 * with sessions in its Computer from before it. The real Computer, the real Org, the real route.
 */

const ORG = "org-adopt-idle";
const WORKOS = "user_01HADPT0000000000000000001";
const USER = "usr_01hadpt0000000000000000001";
const OLD = "cs_00000000000000a1";
const e = env as unknown as { COMPUTERS: DurableObjectNamespace; ORGS: DurableObjectNamespace };

const get = async (path: string, at: unknown = env) => {
  const url = new URL(`https://blue.test/v1/computer${path}`);
  const identity = { kind: "user", userId: WORKOS, accountId: ORG, organizationId: ORG, role: "member" } as RequestIdentity;
  const res = await routeComputerApi(new Request(url), at as never, identity, ORG, { computerApi: async () => { throw new Error("not the Computer's"); } } as never, url.pathname.slice("/v1/computer".length));
  return { status: res.status, body: (await res.json()) as any };
};

describe("Org: lazy adoption", () => {
  it("an idle organization's first GET sessions adopts and shows its old sessions", async () => {
    await runInDurableObject(e.COMPUTERS.getByName(ORG), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, session_id, origin_type, owner_user_id, title, created_at, updated_at) VALUES (?, '', '', '', '', ?, 'api', ?, 'Old API session', 1000, 1000)",
        `api:${OLD}`, OLD, USER,
      );
      state.storage.sql.exec(
        "INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, created_at, updated_at) VALUES ('T1:C1:1.0', 'T1', 'C1', '1.0', 'U1', 'Old Slack thread', 2000, 2000)",
      );
    });
    // The first read waits for the adoption and answers with the history: no 503, no empty list.
    const list = await get("/sessions");
    expect(list.status).toBe(200);
    expect(list.body.sessions.map((s: { id: string; title: string }) => [s.id, s.title])).toContainEqual([OLD, "Old API session"]);
    const held = await runInDurableObject(e.ORGS.getByName(ORG), (_i, state) => state.storage.sql.exec("SELECT title FROM session ORDER BY created_at").toArray());
    expect(held).toEqual([{ title: "Old API session" }, { title: "Old Slack thread" }]);
    expect((await get(`/sessions/${OLD}`)).body.session).toMatchObject({ id: OLD, title: "Old API session" });
  });

  it("a read while a page cannot be fetched is 503 adopting, retryable", async () => {
    const failing = { ORGS: { getByName: () => ({ threads: async () => { throw new Error("adopting"); } }) } };
    const r = await get("/work/threads", failing);
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: "adopting", retryAfterMs: 5_000 });
  });
});
