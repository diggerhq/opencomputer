import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Principal } from "../src/actor/contracts.js";
import { RETRY_MS } from "../src/delivery/contract.js";
import type { DeliveryDurableObject } from "../src/delivery/durable-object.js";
import { sign } from "../src/delivery/webhook.js";
import type { FakeOccurrence, FakeOrg, FakeSessionLog, FakeSlack } from "./fixtures/delivery-test-worker.js";

const bindings = env as unknown as {
  DELIVERY: DurableObjectNamespace<DeliveryDurableObject>;
  ORGS: DurableObjectNamespace<FakeOrg>;
  SESSION_LOG: DurableObjectNamespace<FakeSessionLog>;
  SLACK: DurableObjectNamespace<FakeSlack>;
};

type Call = { host: string; path: string; status: number; occurrence: string; timestamp: string; signature: string; body: string };
const calls = async (host: string): Promise<Call[]> => ((await (await fetch("https://hooks.test/calls")).json()) as Call[]).filter((c) => c.host === host);

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
  it("delivers a signed occurrence, retries a failing endpoint on the schedule, and moves its cursor regardless", async () => {
    const org = "org_hook";
    const delivery = bindings.DELIVERY.getByName(`${org}:webhook`);
    const created = await delivery.setEndpoint(member(org), "wh_ok", { url: "https://ok.hooks.test/in" });
    if (!created.ok) throw new Error("refused");
    const secret = created.endpoint.secret!;
    expect(secret).toMatch(/^whsec_/);
    await delivery.setEndpoint(member(org), "wh_flaky", { url: "https://fail-2.hooks.test/in", kinds: ["turn.completed"] });

    const head = await bindings.ORGS.getByName(org).add([
      occurrence(1, "turn.completed"),
      occurrence(2, "ask.opened"),
      // Not the creator's to see: Org does not return it to them, so it is not sent.
      occurrence(3, "turn.completed", { audience: "member:usr_2" }),
    ]);
    await delivery.poke(head);
    await expect.poll(() => calls("ok.hooks.test")).toHaveLength(2);
    expect(await delivery.status()).toEqual({ cursor: 3, behind: 0, dead: 0 });

    const [first, second] = await calls("ok.hooks.test");
    expect(first).toMatchObject({ path: "/in", occurrence: "cs_a:1:1" });
    expect(JSON.parse(first!.body)).toEqual({ n: "o1.1", key: "cs_a:1:1", kind: "turn.completed", sessionId: "cs_a", trackId: null, by: "user:usr_1", at: "2026-11-25T10:00:00.000Z" });
    expect(first!.signature).toBe(await sign(secret, first!.timestamp, first!.body));
    expect(second!.occurrence).toBe("cs_a:1:2");

    // The flaky endpoint took only the kind it asked for, failed, and is owed again after 5 s.
    await expect.poll(() => calls("fail-2.hooks.test")).toHaveLength(1);
    await expect.poll(async () => (await owedRows(delivery))[0]?.tries).toBe(1);
    let [owedCall] = await owedRows(delivery);
    expect(owedCall!.wait).toBeGreaterThan(RETRY_MS[0]! - 2_000);
    expect(owedCall!.wait).toBeLessThanOrEqual(RETRY_MS[0]!);
    await elapse(delivery);
    [owedCall] = await owedRows(delivery);
    expect(owedCall).toMatchObject({ call: "webhook", tries: 2 });
    expect(owedCall!.wait).toBeGreaterThan(RETRY_MS[1]! - 2_000);
    await elapse(delivery);
    expect((await calls("fail-2.hooks.test")).map((c) => c.status)).toEqual([500, 500, 200]);
    // The private occurrence was dropped behind it, not sent.
    expect(await owedRows(delivery)).toEqual([]);
    expect(await calls("ok.hooks.test")).toHaveLength(2);
  });

  it("puts a delivery that keeps failing on the dead list, and never calls a private address or follows a redirect", async () => {
    const org = "org_dead";
    const delivery = bindings.DELIVERY.getByName(`${org}:webhook`);
    for (const [id, host] of [["wh_private", "private"], ["wh_meta", "metadata"], ["wh_redirect", "redirect"]] as const) {
      expect(await delivery.setEndpoint(member(org), id, { url: `https://${host}.hooks.test/in` })).toMatchObject({ ok: true });
    }
    await delivery.poke(await bindings.ORGS.getByName(org).add([occurrence(1, "turn.completed")]));
    await expect.poll(async () => (await owedRows(delivery)).map((row) => row.tries)).toEqual([1, 1, 1]);
    for (let i = 0; i < RETRY_MS.length; i += 1) await elapse(delivery);
    expect(await owedRows(delivery)).toEqual([]);
    expect(await delivery.status()).toEqual({ cursor: 1, behind: 0, dead: 3 });
    expect(await calls("private.hooks.test")).toEqual([]);
    expect(await calls("metadata.hooks.test")).toEqual([]);
    expect(await calls("ok.hooks.test").then((all) => all.filter((c) => c.path === "/elsewhere"))).toEqual([]);
    expect((await calls("redirect.hooks.test")).length).toBe(RETRY_MS.length + 1);
  });

  it("keeps endpoints for members and keys with work:write only, on https and port 443", async () => {
    const org = "org_endpoints";
    const delivery = bindings.DELIVERY.getByName(`${org}:webhook`);
    expect(await delivery.setEndpoint(member(org, { kind: "agent", session: "cs_x" }), "wh_1", { url: "https://ok.hooks.test/" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await delivery.setEndpoint(member(org, { scopes: ["work:read"] }), "wh_1", { url: "https://ok.hooks.test/" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await delivery.setEndpoint(member(org), "wh_1", { url: "http://ok.hooks.test/" })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await delivery.setEndpoint(member(org), "wh_1", { url: "https://ok.hooks.test:8443/" })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await bindings.DELIVERY.getByName(`${org}:wake`).listEndpoints(member(org))).toMatchObject({ ok: false, code: "not_found" });

    const created = await delivery.setEndpoint(member(org), "wh_1", { url: "https://ok.hooks.test/", kinds: ["thread.done"] });
    expect(created).toMatchObject({ ok: true, endpoint: { id: "wh_1", kinds: ["thread.done"], enabled: true, createdBy: "user:usr_1" } });
    const updated = await delivery.setEndpoint(member(org), "wh_1", { url: "https://ok.hooks.test/two", enabled: false });
    expect(updated).toMatchObject({ ok: true, endpoint: { url: "https://ok.hooks.test/two", enabled: false } });
    // The secret is shown once, when the endpoint is made.
    expect((updated as { endpoint: { secret?: string } }).endpoint.secret).toBeUndefined();
    expect(await delivery.listEndpoints(member(org))).toEqual({ ok: true, endpoints: [{ id: "wh_1", url: "https://ok.hooks.test/two", kinds: [], enabled: false, createdBy: "user:usr_1" }] });
    expect(await delivery.removeEndpoint(member(org), "wh_1")).toEqual({ ok: true, removed: true });
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
