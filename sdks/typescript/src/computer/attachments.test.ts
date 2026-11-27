// Pending attachments (work 126): uploaded ahead of the message, which waits for them; resumed by
// repeating the PUT under the same id; refused at the limits. The server is a fake fetch.

import { describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_BYTES, createClient, memoryFiles, memoryStorage, PENDING_ATTACHMENTS_MAX_BYTES, Refused } from "./index.js";
import type { Channel, Files, PendingAttachment, Storage } from "./index.js";

const silent: Channel = { send() {}, onFrame() {}, onState() {}, close() {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Call = { path: string; init: RequestInit; at: number };

/** A server whose answer to each request the test decides; replies are in order of arrival. */
function setup(o: { storage?: Storage; files?: Files; reply?: (c: Call, n: number) => Response | Promise<Response>; upload?: boolean } = {}) {
  const calls: Call[] = [];
  const storage = o.storage ?? memoryStorage();
  const files = o.files ?? memoryFiles();
  let n = 0;
  const reply = o.reply ?? (() => json(201, { attachment: { state: "ready" } }));
  const fetch = async (path: string, init?: RequestInit) => {
    const c = { path, init: init ?? {}, at: Date.now() };
    calls.push(c);
    return reply(c, n++);
  };
  const client = createClient({
    principal: { org: "org_1", subject: "usr_1" },
    fetch,
    connect: () => silent,
    storage,
    files,
    // Backoffs 100 times shorter.
    setTimeout: (fn, ms) => setTimeout(fn, ms / 100),
    upload: o.upload
      ? async (path, req) => {
          req.onProgress(req.body.size / 2, req.body.size);
          const res = await fetch(path, { method: req.method, headers: req.headers, body: req.body });
          req.onProgress(req.body.size, req.body.size);
          return res;
        }
      : undefined,
  });
  const puts = () => calls.filter((c) => c.init.method === "PUT");
  const posts = () => calls.filter((c) => c.init.method === "POST");
  return { client, calls, storage, files, puts, posts };
}

const file = (name = "photo.png", bytes = 5, type = "image/png") => new File([new Uint8Array(bytes)], name, { type });

async function until(what: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

describe("attach", () => {
  it("uploads at once with the file's name and type, and a turn naming it waits until it is ready", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client, puts, posts } = setup({
      reply: async (c) => {
        if (c.init.method === "PUT") {
          await gate;
          return json(201, { attachment: { id: "at_x", state: "ready" } });
        }
        return json(202, {});
      },
    });
    await client.ready;
    const { id, state } = client.attach("cs_1", file("my photo.png"));
    expect(id).toMatch(/^at_[0-9a-hjkmnp-tv-z]{16}$/);
    expect(state.get()).toMatchObject({ id, sessionId: "cs_1", name: "my photo.png", mimetype: "image/png", bytes: 5, state: "queued" });
    await until(() => puts().length === 1);
    expect(state.get().state).toBe("uploading");
    const put = puts()[0];
    expect(put.path).toBe(`/sessions/cs_1/attachments/${id}/content`);
    const h = new Headers(put.init.headers);
    expect(h.get("content-type")).toBe("image/png");
    expect(h.get("content-disposition")).toBe("attachment; filename*=UTF-8''my%20photo.png");
    expect(put.init.body).toBeInstanceOf(Blob);

    const { settled } = client.send("cs_1", "look", { attachments: [id] });
    expect(client.pending().get()).toMatchObject([{ kind: "turn", attachments: [id] }]);
    await sleep(30);
    expect(posts()).toHaveLength(0); // not ready yet
    release();
    await settled;
    expect(state.get()).toMatchObject({ state: "ready", progress: 1 });
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0].init.body))).toMatchObject({ input: "look", attachments: [id] });
    // Accepted: the local file and record are gone.
    await until(() => client.attachments().get().length === 0);
    expect(await client.attachmentFile(id)).toBeUndefined();
    client.close();
  });

  it("does not hold a turn without attachments behind one with", async () => {
    const { client, posts } = setup({ reply: (c) => (c.init.method === "PUT" ? new Promise<Response>(() => {}) : json(202, {})) });
    await client.ready;
    const { id } = client.attach("cs_1", file());
    client.send("cs_2", "plain", {});
    client.send("cs_1", "with", { attachments: [id] });
    await until(() => posts().length === 1);
    await sleep(30);
    expect(posts().map((c) => c.path)).toEqual(["/sessions/cs_2/turns"]);
    client.close();
  });

  it("reports progress through `upload` and a create carries the ids", async () => {
    const { client, posts } = setup({ upload: true, reply: (c) => (c.init.method === "PUT" ? json(201, {}) : json(201, { session: {} })) });
    await client.ready;
    const seen: number[] = [];
    const { id, state } = client.attach("cs_new", file("a.bin", 10, ""));
    state.subscribe((a) => seen.push(a.progress));
    const { settled } = client.createSession({ id: "cs_new", input: "hi", attachments: [id] });
    await settled;
    expect(seen).toContain(0.5);
    expect(state.get().progress).toBe(1);
    expect(JSON.parse(String(posts()[0].init.body))).toMatchObject({ id: "cs_new", attachments: [id] });
    client.close();
  });

  it("uploads two at a time", async () => {
    const open: (() => void)[] = [];
    const { client, puts } = setup({
      reply: (c) =>
        c.init.method === "PUT" ? new Promise<Response>((resolve) => open.push(() => resolve(json(201, {})))) : json(202, {}),
    });
    await client.ready;
    for (let i = 0; i < 3; i++) client.attach("cs_1", file(`${i}.png`));
    await sleep(30);
    expect(puts()).toHaveLength(2);
    open[0]();
    await until(() => puts().length === 3);
    client.close();
  });
});

describe("resume", () => {
  it("repeats the PUT under the same id after a reload", async () => {
    const storage = memoryStorage();
    const files = memoryFiles();
    const first = setup({ storage, files, reply: () => new Promise<Response>(() => {}) });
    await first.client.ready;
    const { id } = first.client.attach("cs_1", file());
    await until(() => first.puts().length === 1);
    first.client.close();

    const second = setup({ storage, files });
    await second.client.ready;
    expect(second.client.attachments().get()).toMatchObject([{ id, state: "queued" }]);
    await until(() => second.client.attachments().get()[0]?.state === "ready");
    expect(second.puts()[0].path).toBe(first.puts()[0].path);
    second.client.close();
  });

  it("retries a 503 and a network error with backoff", async () => {
    const { client, puts } = setup({
      reply: (c, n) => (n === 0 ? json(503, { error: { code: "unavailable" } }) : n === 1 ? Promise.reject(new Error("offline")) : json(201, {})),
    });
    await client.ready;
    const { state } = client.attach("cs_1", file());
    await until(() => state.get().state === "ready");
    expect(puts()).toHaveLength(3);
    client.close();
  });

  it("uploads under a fresh server id after a 410, and the turn names that one", async () => {
    const { client, puts, posts } = setup({
      reply: (c, n) => (c.init.method === "PUT" ? (n === 0 ? json(410, { error: { code: "attachment_deleted" } }) : json(201, {})) : json(202, {})),
    });
    await client.ready;
    const { id, state } = client.attach("cs_1", file());
    const { settled } = client.send("cs_1", "x", { attachments: [id] });
    await settled;
    expect(state.get().id).toBe(id);
    expect(puts()).toHaveLength(2);
    const fresh = puts()[1].path.split("/")[4];
    expect(fresh).not.toBe(id);
    expect(JSON.parse(String(posts()[0].init.body)).attachments).toEqual([fresh]);
    client.close();
  });
});

describe("refusals and limits", () => {
  it("marks a 413 failed with the reason, and a message naming it fails unsent", async () => {
    const { client, posts } = setup({ reply: () => json(413, { error: { code: "attachment_too_large", message: "over 100 MB" } }) });
    await client.ready;
    const { id, state } = client.attach("cs_1", file());
    await until(() => state.get().state === "failed");
    expect(state.get().error).toEqual({ code: "attachment_too_large", reason: "over 100 MB" });
    const failures: string[] = [];
    client.failures.subscribe((f) => failures.push(f.code));
    await expect(client.send("cs_1", "x", { attachments: [id] }).settled).rejects.toBeInstanceOf(Refused);
    expect(failures).toEqual(["attachment_too_large"]);
    expect(posts()).toHaveLength(0);
    client.close();
  });

  it("treats the quota's 429 as a refusal, not a retry", async () => {
    const { client, puts } = setup({ reply: () => json(429, { error: { code: "attachment_quota", message: "session over 1 GB" } }) });
    await client.ready;
    const { state } = client.attach("cs_1", file());
    await until(() => state.get().state === "failed");
    expect(puts()).toHaveLength(1);
    client.close();
  });

  it("refuses a file over the size limit and pending files over the budget, before anything is written", async () => {
    const { client, storage } = setup();
    await client.ready;
    class Big extends Blob {
      constructor(private n: number) {
        super([]);
      }
      override get size() {
        return this.n;
      }
    }
    expect(() => client.attach("cs_1", new Big(ATTACHMENT_MAX_BYTES + 1))).toThrow(Refused);
    client.attach("cs_1", new Big(ATTACHMENT_MAX_BYTES));
    client.attach("cs_1", new Big(ATTACHMENT_MAX_BYTES));
    let error: Refused | null = null;
    try {
      client.attach("cs_1", new Big(PENDING_ATTACHMENTS_MAX_BYTES - 2 * ATTACHMENT_MAX_BYTES + 1));
    } catch (e) {
      error = e as Refused;
    }
    expect(error?.code).toBe("attachment_budget");
    await sleep(5);
    expect((await storage.list("att/")).length).toBe(2);
    client.close();
  });

  it("refuses more than ten per message", async () => {
    const { client } = setup();
    await client.ready;
    expect(() => client.send("cs_1", "x", { attachments: Array.from({ length: 11 }, (_, i) => `at_${i}`) })).toThrow(Refused);
    client.close();
  });

  it("removing a chip stops the upload, drops the file and deletes the row", async () => {
    const { client, calls, storage } = setup({ reply: (c) => (c.init.method === "PUT" ? new Promise<Response>(() => {}) : new Response(null, { status: 204 })) });
    await client.ready;
    const { id } = client.attach("cs_1", file());
    await until(() => calls.length === 1);
    expect(calls[0].init.signal?.aborted).toBe(false);
    await client.removeAttachment(id);
    expect(calls[0].init.signal?.aborted).toBe(true);
    expect(calls[1]).toMatchObject({ path: `/sessions/cs_1/attachments/${id}`, init: { method: "DELETE" } });
    expect(client.attachments().get()).toEqual([]);
    expect(await storage.list("att/")).toEqual([]);
    expect(await client.attachmentFile(id)).toBeUndefined();
    client.close();
  });
});

describe("readAttachment", () => {
  it("answers the bytes, and throws the refusal", async () => {
    const { client, calls } = setup({
      reply: (c) => (c.path.endsWith("/at_ok/content") ? new Response(new Uint8Array([1, 2, 3]), { status: 200 }) : json(404, { error: { code: "attachment_not_found" } })),
    });
    await client.ready;
    const blob = await client.readAttachment("cs_1", "at_ok");
    expect(blob.size).toBe(3);
    expect(calls[0].path).toBe("/sessions/cs_1/attachments/at_ok/content");
    await expect(client.readAttachment("cs_1", "at_gone")).rejects.toMatchObject({ code: "attachment_not_found" });
    client.close();
  });
});

describe("a pending attachment", () => {
  it("is in `attachments()` for the store to draw", async () => {
    const { client } = setup({ reply: () => new Promise<Response>(() => {}) });
    await client.ready;
    const seen: PendingAttachment[][] = [];
    client.attachments().subscribe((l) => seen.push(l));
    client.attach("cs_1", file());
    await sleep(20);
    expect(seen[0]).toHaveLength(1);
    expect(seen.at(-1)![0].state).toBe("uploading");
    client.close();
  });
});
