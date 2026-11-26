// A change of settings is a queued session write (spec 19.1); a secret is sent at once and never
// stored (the value must not outlive the request).

import { describe, expect, it } from "vitest";
import { createClient, memoryStorage, Refused } from "./index.js";
import type { Channel, Storage } from "./index.js";

const silent: Channel = { send() {}, onFrame() {}, onState() {}, close() {} };

function setup(reply: (path: string, init: RequestInit) => Response) {
  const calls: { path: string; init: RequestInit }[] = [];
  const storage: Storage = memoryStorage();
  const client = createClient({
    principal: { org: "org_1", subject: "usr_1" },
    fetch: async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return reply(path, init ?? {});
    },
    connect: () => silent,
    storage,
  });
  return { client, calls, storage };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("settings", () => {
  it("is a PATCH of the session with an idempotency key, pending until answered", async () => {
    const { client, calls } = setup(() => json(200, { session: {} }));
    await client.ready;
    const { settled } = client.settings("cs_1", { model: "opus", mode: "plan" });
    expect(client.pending().get().map((p) => p.kind)).toEqual(["settings"]);
    await settled;
    const call = calls.find((c) => c.path === "/sessions/cs_1")!;
    expect(call.init.method).toBe("PATCH");
    expect(JSON.parse(String(call.init.body))).toEqual({ model: "opus", mode: "plan" });
    expect(new Headers(call.init.headers).get("Idempotency-Key")).toBeTruthy();
    expect(client.pending().get()).toEqual([]);
    client.close();
  });
});

describe("setSecret", () => {
  it("is a PUT that leaves nothing in storage", async () => {
    const { client, calls, storage } = setup(() => new Response(null, { status: 204 }));
    await client.ready;
    await client.setSecret("cs_1", "API_TOKEN", { value: "s3cret", file: false });
    const call = calls.find((c) => c.path === "/sessions/cs_1/secrets/API_TOKEN")!;
    expect(call.init.method).toBe("PUT");
    expect(JSON.parse(String(call.init.body))).toEqual({ value: "s3cret", file: false });
    expect(client.pending().get()).toEqual([]);
    const kept = JSON.stringify(await storage.list(""));
    expect(kept).not.toContain("s3cret");
    client.close();
  });

  it("throws the refusal", async () => {
    const { client } = setup(() => json(403, { error: { code: "forbidden", message: "no" } }));
    await client.ready;
    await expect(client.setSecret("cs_1", "X", { value: "v", file: false })).rejects.toBeInstanceOf(Refused);
    client.close();
  });
});
