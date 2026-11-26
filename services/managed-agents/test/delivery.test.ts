import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Principal } from "../src/actor/contracts.js";
import { RETRY_MS } from "../src/delivery/contract.js";
import type { DeliveryDurableObject } from "../src/delivery/durable-object.js";
import type { FakeOccurrence, FakeOrg, FakeSessionLog, FakeSlack } from "./fixtures/delivery-test-worker.js";

const bindings = env as unknown as {
  DELIVERY: DurableObjectNamespace<DeliveryDurableObject>;
  ORGS: DurableObjectNamespace<FakeOrg>;
  SESSION_LOG: DurableObjectNamespace<FakeSessionLog>;
  SLACK: DurableObjectNamespace<FakeSlack>;
};

type SvixState = {
  apps: Record<string, { uid: string; url: string; filterTypes?: string[]; channels?: string[]; disabled: boolean; metadata?: Record<string, string> }[]>;
  messages: { app: string; eventType: string; eventId: string; idempotencyKey: string; channels: string[]; payload: unknown }[];
};
const svix = async (): Promise<SvixState> => (await (await fetch("https://api.svix.com/_test")).json()) as SvixState;
const messagesOf = async (app: string) => (await svix()).messages.filter((m) => m.app === app);

const member = (org: string, over: Partial<Principal> = {}): Principal => ({
  org,
  subject: "usr_1",
  kind: "member",
  via: "app",
  scopes: ["work:read", "work:write"],
  audiences: ["org", "member:usr_1"],
  admin: false,
  credential: { id: "cred_1", expiresAt: null },
  ...over,
});

const occurrence = (n: number, kind: string, over: Partial<FakeOccurrence> = {}): FakeOccurrence => ({
  n,
  key: `cs_a:1:${n}`,
  kind,
  sessionId: "cs_a",
  trackId: null,
  by: "user:usr_1",
  at: "2026-11-25T10:00:00.000Z",
  audience: "org",
  ...over,
});

/** Makes every owed call and pending wake due now, and runs the alarm: time passing, without the wait. */
async function elapse(stub: DurableObjectStub<DeliveryDurableObject>): Promise<void> {
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("UPDATE _owed SET at = 0");
    state.storage.sql.exec("UPDATE pending SET due_at = 0");
    state.storage.sql.exec("UPDATE _alarm SET at = 0 WHERE purpose IN ('owed', 'wake')");
    state.storage.sql.exec("INSERT OR IGNORE INTO _alarm (purpose, at) VALUES ('owed', 0)");
    if (state.storage.sql.exec("SELECT 1 FROM pending").toArray().length > 0) state.storage.sql.exec("INSERT OR IGNORE INTO _alarm (purpose, at) VALUES ('wake', 0)");
  });
  await runInDurableObject(stub, (instance) => (instance as unknown as { alarm(): Promise<void> }).alarm());
}

const owedRows = (stub: DurableObjectStub<DeliveryDurableObject>): Promise<{ call: string; tries: number; wait: number }[]> =>
  runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec("SELECT call, tries, at FROM _owed ORDER BY n")
      .toArray()
      .map((row) => ({ call: row.call as string, tries: row.tries as number, wait: (row.at as number) - Date.now() })),
  );

describe("Delivery: webhook", () => {
  it("hands each occurrence to Svix once, on the occurrence's key and audience, retrying until Svix takes it", async () => {
    const org = "org_flaky";
    const delivery = bindings.DELIVERY.getByName(`${org}:webhook`);
    // No webhook yet: Svix is not asked.
    await delivery.poke(await bindings.ORGS.getByName(org).add([occurrence(1, "turn.completed")]));
    await expect.poll(async () => (await delivery.status()).cursor).toBe(1);
    expect(await owedRows(delivery)).toEqual([]);

    const created = await delivery.setEndpoint(member(org), "wh_ok", { url: "https://ok.hooks.test/in", kinds: ["turn.completed"] });
    if (!created.ok) throw new Error("refused");
    expect(created.endpoint.secret).toMatch(/^whsec_/);
    const [endpoint] = (await svix()).apps[`work-${org}`]!;
    expect(endpoint).toMatchObject({ uid: "wh_ok", url: "https://ok.hooks.test/in", filterTypes: ["turn.completed"], channels: ["org", "member.usr_1"], disabled: false });

    const head = await bindings.ORGS.getByName(org).add([occurrence(2, "turn.completed"), occurrence(3, "ask.opened", { audience: "member:usr_2" })]);
    await delivery.poke(head);
    // Svix answers 503 twice: the messages stay owed, in order, and the cursor has moved on.
    await expect.poll(async () => (await owedRows(delivery)).map((row) => row.tries)).toEqual([1, 0]);
    expect(await delivery.status()).toEqual({ cursor: 3, behind: 0, dead: 0 });
    await elapse(delivery);
    await elapse(delivery);
    expect(await owedRows(delivery)).toEqual([]);
    expect(await messagesOf(`work-${org}`)).toEqual([
      {
        app: `work-${org}`,
        eventType: "turn.completed",
        eventId: "cs_a.1.2",
        idempotencyKey: "cs_a:1:2",
        channels: ["org"],
        payload: { n: "o1.2", key: "cs_a:1:2", kind: "turn.completed", sessionId: "cs_a", trackId: null, by: "user:usr_1", at: "2026-11-25T10:00:00.000Z" },
        id: "msg_1",
      },
      // Svix sends it to no endpoint of this creator's: its channel is not one of theirs.
      expect.objectContaining({ eventType: "ask.opened", idempotencyKey: "cs_a:1:3", channels: ["member.usr_2"] }),
    ]);
  });

  it("keeps endpoints in Svix, for members and keys with work:write only, on https", async () => {
    const org = "org_endpoints";
    const delivery = bindings.DELIVERY.getByName(`${org}:webhook`);
    expect(await delivery.setEndpoint(member(org, { kind: "agent", session: "cs_x" }), "wh_1", { url: "https://ok.hooks.test/" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await delivery.setEndpoint(member(org, { scopes: ["work:read"] }), "wh_1", { url: "https://ok.hooks.test/" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await delivery.setEndpoint(member(org), "wh_1", { url: "http://ok.hooks.test/" })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await bindings.DELIVERY.getByName(`${org}:wake`).listEndpoints(member(org))).toMatchObject({ ok: false, code: "not_found" });
    expect(await delivery.listEndpoints(member(org))).toEqual({ ok: true, endpoints: [] });

    const created = await delivery.setEndpoint(member(org), "wh_1", { url: "https://ok.hooks.test/", kinds: ["thread.done"] });
    expect(created).toMatchObject({ ok: true, endpoint: { id: "wh_1", kinds: ["thread.done"], enabled: true, createdBy: "user:usr_1" } });
    const updated = await delivery.setEndpoint(member(org), "wh_1", { url: "https://ok.hooks.test/two", enabled: false });
    expect(updated).toMatchObject({ ok: true, endpoint: { url: "https://ok.hooks.test/two", enabled: false } });
    // The secret is shown once, when the endpoint is made.
    expect((updated as { endpoint: { secret?: string } }).endpoint.secret).toBeUndefined();
    expect(await delivery.listEndpoints(member(org))).toEqual({ ok: true, endpoints: [{ id: "wh_1", url: "https://ok.hooks.test/two", kinds: [], enabled: false, createdBy: "user:usr_1" }] });
    expect(await delivery.removeEndpoint(member(org), "wh_1")).toEqual({ ok: true, removed: true });
    expect(await delivery.removeEndpoint(member(org), "wh_1")).toEqual({ ok: true, removed: false });
    expect(await delivery.listEndpoints(member(org))).toEqual({ ok: true, endpoints: [] });
  });
});

describe("Delivery: wake", () => {
  it("gathers a target's occurrences into one platform turn, and does not wake an agent with its own act", async () => {
    const org = "org_wake";
    const delivery = bindings.DELIVERY.getByName(`${org}:wake`);
    const head = await bindings.ORGS.getByName(org).add(
      [
        occurrence(1, "turn.completed", { by: "agent:cs_a" }),
        occurrence(2, "message.received"),
        occurrence(3, "ask.opened", { by: "agent:cs_a" }),
        // The track's agent's own act: it wakes the parent, not itself.
        occurrence(4, "thread.placed", { by: "agent:cs_agent" }),
      ],
      { 1: ["cs_agent", "cs_parent"], 2: ["cs_agent"], 3: ["cs_agent"], 4: ["cs_agent", "cs_parent"] },
    );
    await delivery.poke(head);
    await expect.poll(async () => (await delivery.status()).cursor).toBe(4);
    // Debounced: nothing is sent until the batch is due.
    expect(await bindings.SESSION_LOG.getByName("cs_agent").calls()).toEqual([]);
    await bindings.SESSION_LOG.getByName("cs_parent").refuse(1);
    await elapse(delivery);

    const agent = (await bindings.SESSION_LOG.getByName("cs_agent").calls()) as { by: string; entry: unknown }[];
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({ by: "platform", entry: { kind: "turn", body: { input: "digest for cs_agent: 1 to 3", ifBusy: "queue" } } });
    expect((agent[0]!.entry as { id: string }).id).toMatch(/^tn_[0-9a-f]{24}$/);
    // The parent's inbox was full: the wake stays owed and is delivered on the retry.
    expect(await bindings.SESSION_LOG.getByName("cs_parent").calls()).toEqual([]);
    expect(await owedRows(delivery)).toMatchObject([{ call: "wake", tries: 1 }]);
    await elapse(delivery);
    expect(await bindings.SESSION_LOG.getByName("cs_parent").calls()).toMatchObject([{ entry: { body: { input: "digest for cs_parent: 1 to 4" } } }]);
    expect(await delivery.status()).toEqual({ cursor: 4, behind: 0, dead: 0 });
    // One that keeps failing holds its target's later wakes for minutes, then goes to the dead list.
    expect(RETRY_MS).toHaveLength(8);
    expect(RETRY_MS.reduce((sum, wait) => sum + wait, 0)).toBeLessThan(5 * 60_000);
  });
});

describe("Delivery: slack", () => {
  it("passes a refused turn and a machine's change to the Slack actor when Org names a thread", async () => {
    const org = "org_slack";
    const delivery = bindings.DELIVERY.getByName(`${org}:slack`);
    const refused = { kind: "refused" as const, threadKey: "C1:1.2", person: "U1", code: "credits" };
    const head = await bindings.ORGS.getByName(org).add(
      [occurrence(1, "turn.completed"), occurrence(2, "turn.refused"), occurrence(3, "machine.changed", { sessionId: null }), occurrence(4, "turn.refused", { sessionId: "cs_b" })],
      {},
      { 2: refused, 3: { kind: "machine", state: { status: "waking" } as never, threadKeys: [] }, 4: null },
    );
    await delivery.poke(head);
    await expect.poll(() => bindings.SLACK.getByName(org).calls()).toEqual([refused]);
    await expect.poll(() => owedRows(delivery)).toEqual([]);
    expect(await delivery.status()).toEqual({ cursor: 4, behind: 0, dead: 0 });
  });

  it("reads on from its cursor, a page at a time, and repeats a read from its alarm", async () => {
    const org = "org_pages";
    const delivery = bindings.DELIVERY.getByName(`${org}:slack`);
    const entries = Array.from({ length: 250 }, (_, i) => occurrence(i + 1, "turn.completed"));
    await bindings.ORGS.getByName(org).add(entries);
    await delivery.poke(250);
    await expect.poll(async () => (await delivery.status()).cursor).toBe(250);
    expect((await bindings.ORGS.getByName(org).calls()).map((c) => c.after)).toEqual(["o1.0", "o1.100", "o1.200"]);

    // A poke that names a head Org's read has not reached leaves it behind, and the alarm reads again.
    await delivery.poke(252);
    await expect.poll(async () => (await bindings.ORGS.getByName(org).calls()).length).toBe(4);
    expect(await delivery.status()).toEqual({ cursor: 250, behind: 2, dead: 0 });
    await bindings.ORGS.getByName(org).add([occurrence(251, "turn.completed"), occurrence(252, "turn.completed")]);
    await runInDurableObject(delivery, (_, state) => void state.storage.sql.exec("UPDATE _alarm SET at = 0 WHERE purpose = 'poll'"));
    await runInDurableObject(delivery, (instance) => (instance as unknown as { alarm(): Promise<void> }).alarm());
    expect(await delivery.status()).toEqual({ cursor: 252, behind: 0, dead: 0 });
  });
});
