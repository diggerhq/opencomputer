// Pending attachments (work 126): uploaded ahead of the message, in three steps (the row, the bytes
// to a signed URL, the completion); the message waits for them. A reload keeps what is `ready` and
// fails what was interrupted. The server and the store are a fake fetch.

import { describe, expect, it } from "vitest";
import { createClient, memoryStorage, Refused } from "./index.js";
import type { PendingAttachment, Storage } from "./index.js";

const silent = { send() {}, onFrame() {}, onState() {}, close() {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Step = "create" | "bytes" | "complete" | "url" | "delete" | "write";
type Call = { path: string; init: RequestInit; at: number; step: Step };
type Answer = Response | undefined | Promise<Response | undefined>;

const STORE = "https://store.test/bucket/";

function stepOf(path: string, method: string): Step {
  if (path.startsWith(STORE)) return "bytes";
  if (path.endsWith("/complete")) return "complete";
  if (/\/url(\?|$)/.test(path)) return "url";
  if (method === "DELETE") return "delete";
  return method === "PUT" ? "create" : "write";
}

/** What the server and the store answer when the test does not say. */
function usual(c: Call): Response {
  const id = c.path.split("/")[4];
  if (c.step === "create") {
    const upload = { url: `${STORE}${id}?sig=1`, method: "PUT", headers: { "content-type": JSON.parse(String(c.init.body)).mimetype }, expiresAt: new Date(Date.now() + 900_000).toISOString() };
    return json(201, { attachment: { id, state: "uploading" }, upload });
  }
  if (c.step === "bytes") return new Response(null, { status: 200 });
  if (c.step === "complete") return json(200, { attachment: { id, state: "ready" } });
  if (c.step === "delete") return new Response(null, { status: 204 });
  return json(202, {});
}

/** A server whose answer to each request the test may decide (`n` counts the requests of that step). */
function setup(o: { storage?: Storage; reply?: (c: Call, n: number) => Answer; now?: () => number } = {}) {
  const calls: Call[] = [];
  const storage = o.storage ?? memoryStorage();
  const seen: Record<string, number> = {};
  const fetch = async (path: string, init?: RequestInit) => {
    const c: Call = { path, init: init ?? {}, at: Date.now(), step: stepOf(path, init?.method ?? "GET") };
    calls.push(c);
    const n = seen[c.step] ?? 0;
    seen[c.step] = n + 1;
    return (await o.reply?.(c, n)) ?? usual(c);
  };
  const client = createClient({
    principal: { org: "org_1", subject: "usr_1" },
    fetch,
    connect: () => silent,
    storage,
    now: o.now,
    // Backoffs 100 times shorter.
    setTimeout: (fn, ms) => setTimeout(fn, ms / 100),
    uploadTo: async (url, req) => {
      req.onProgress(req.body.size / 2, req.body.size);
      const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
      req.onProgress(req.body.size, req.body.size);
      return res;
    },
  });
  const step = (s: Step) => calls.filter((c) => c.step === s);
  return { client, calls, storage, step };
}

const file = (name = "photo.png", bytes = 5, type = "image/png") => new File([new Uint8Array(bytes)], name, { type });
const never = () => new Promise<Response>(() => {});

async function until(what: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

describe("attach", () => {
  it("makes the row, sends the bytes to the signed URL, completes, and a turn naming it waits until then", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client, calls, step } = setup({ reply: async (c) => (c.step === "complete" ? void (await gate) : undefined) });
    await client.ready;
    const { id, state } = client.attach("cs_1", file("my photo.png"));
    expect(id).toMatch(/^at_[0-9a-hjkmnp-tv-z]{16}$/);
    expect(state.get()).toMatchObject({ id, sessionId: "cs_1", name: "my photo.png", mimetype: "image/png", bytes: 5, state: "uploading", progress: 0 });
    await until(() => step("complete").length === 1);
    expect(state.get().state).toBe("uploading");
    expect(calls.map((c) => c.step)).toEqual(["create", "bytes", "complete"]);

    const [create, bytes, complete] = calls;
    expect(create.path).toBe(`/sessions/cs_1/attachments/${id}`);
    expect(create.init.method).toBe("PUT");
    expect(JSON.parse(String(create.init.body))).toEqual({ name: "my photo.png", mimetype: "image/png", bytes: 5 });
    // The bytes: to the URL as given, with exactly the headers given.
    expect(bytes.path).toBe(`${STORE}${id}?sig=1`);
    expect(bytes.init.method).toBe("PUT");
    expect(bytes.init.headers).toEqual({ "content-type": "image/png" });
    expect(bytes.init.body).toBeInstanceOf(Blob);
    expect(complete).toMatchObject({ path: `/sessions/cs_1/attachments/${id}/complete`, init: { method: "POST" } });

    const { settled } = client.send("cs_1", "look", { attachments: [id] });
    expect(client.pending().get()).toMatchObject([{ kind: "turn", attachments: [id] }]);
    await sleep(30);
    expect(step("write")).toHaveLength(0); // not ready yet
    release();
    await settled;
    expect(state.get()).toMatchObject({ state: "ready", progress: 1 });
    expect(step("write")).toHaveLength(1);
    expect(JSON.parse(String(step("write")[0].init.body))).toMatchObject({ input: "look", attachments: [id] });
    // Accepted: the record is gone.
    await until(() => client.attachments().get().length === 0);
    client.close();
  });

  it("does not hold a turn without attachments behind one with", async () => {
    const { client, step } = setup({ reply: (c) => (c.step === "create" ? never() : undefined) });
    await client.ready;
    const { id } = client.attach("cs_1", file());
    client.send("cs_2", "plain", {});
    client.send("cs_1", "with", { attachments: [id] });
    await until(() => step("write").length === 1);
    await sleep(30);
    expect(step("write").map((c) => c.path)).toEqual(["/sessions/cs_2/turns"]);
    client.close();
  });

  it("reports the progress of the bytes, and a create carries the ids", async () => {
    const { client, step } = setup({ reply: (c) => (c.step === "write" ? json(201, { session: {} }) : undefined) });
    await client.ready;
    const seen: number[] = [];
    const { id, state } = client.attach("cs_new", file("a.bin", 10, ""));
    state.subscribe((a) => seen.push(a.progress));
    const { settled } = client.createSession({ id: "cs_new", input: "hi", attachments: [id] });
    await settled;
    expect(seen).toContain(0.5);
    expect(state.get().progress).toBe(1);
    expect(JSON.parse(String(step("create")[0].init.body)).mimetype).toBe("application/octet-stream");
    expect(JSON.parse(String(step("write")[0].init.body))).toMatchObject({ id: "cs_new", attachments: [id] });
    client.close();
  });

  it("is ready at once when the server already holds it", async () => {
    const { client, calls } = setup({ reply: (c) => (c.step === "create" ? json(200, { attachment: { state: "ready" } }) : undefined) });
    await client.ready;
    const { state } = client.attach("cs_1", file());
    await until(() => state.get().state === "ready");
    expect(calls.map((c) => c.step)).toEqual(["create"]);
    client.close();
  });

  it("uploads two at a time", async () => {
    const open: (() => void)[] = [];
    const { client, step } = setup({ reply: (c) => (c.step === "bytes" ? new Promise<Response>((resolve) => open.push(() => resolve(new Response(null, { status: 200 })))) : undefined) });
    await client.ready;
    for (let i = 0; i < 3; i++) client.attach("cs_1", file(`${i}.png`));
    await sleep(30);
    expect(step("create")).toHaveLength(2);
    open[0]();
    await until(() => step("create").length === 3);
    client.close();
  });
});

describe("trying again", () => {
  it("retries a 503 and a network error of any step with backoff", async () => {
    const { client, calls } = setup({
      reply: (c, n) => {
        if (n > 0) return undefined;
        if (c.step === "create") return json(503, { error: { code: "unavailable" } });
        if (c.step === "bytes") return Promise.reject(new Error("offline"));
        if (c.step === "complete") return json(500, {});
        return undefined;
      },
    });
    await client.ready;
    const { state } = client.attach("cs_1", file());
    await until(() => state.get().state === "ready");
    // The bytes that arrived are not sent again for a completion that failed.
    expect(calls.map((c) => c.step)).toEqual(["create", "create", "bytes", "create", "bytes", "complete", "complete"]);
    client.close();
  });

  it("starts again from the row when the signed URL expired (403)", async () => {
    const { client, calls, step } = setup({ reply: (c, n) => (c.step === "bytes" && n === 0 ? new Response("<Error/>", { status: 403 }) : undefined) });
    await client.ready;
    const { id, state } = client.attach("cs_1", file());
    await until(() => state.get().state === "ready");
    expect(calls.map((c) => c.step)).toEqual(["create", "bytes", "create", "bytes", "complete"]);
    expect(step("create")[1].path).toBe(`/sessions/cs_1/attachments/${id}`);
    client.close();
  });

  it("gives up on a URL that is refused every time", async () => {
    const { client, step } = setup({ reply: (c) => (c.step === "bytes" ? new Response(null, { status: 403 }) : undefined) });
    await client.ready;
    const { state } = client.attach("cs_1", file());
    await until(() => state.get().state === "failed");
    expect(step("bytes")).toHaveLength(4);
    expect(state.get().error?.code).toBe("upload_refused");
    client.close();
  });

  it("sends the bytes again when the completion did not find them", async () => {
    const { client, calls } = setup({ reply: (c, n) => (c.step === "complete" && n === 0 ? json(409, { error: { code: "attachment_not_uploaded" } }) : undefined) });
    await client.ready;
    const { state } = client.attach("cs_1", file());
    await until(() => state.get().state === "ready");
    expect(calls.map((c) => c.step)).toEqual(["create", "bytes", "complete", "create", "bytes", "complete"]);
    client.close();
  });
});

describe("a reload", () => {
  it("keeps a ready record ready, and its message goes without another upload", async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    await first.client.ready;
    const { id, state } = first.client.attach("cs_1", file());
    await until(() => state.get().state === "ready");
    first.client.close();

    const second = setup({ storage });
    await second.client.ready;
    expect(second.client.attachments().get()).toMatchObject([{ id, state: "ready", progress: 1 }]);
    await second.client.send("cs_1", "x", { attachments: [id] }).settled;
    expect(second.calls.map((c) => c.step)).toEqual(["write"]);
    second.client.close();
  });

  it("fails an interrupted record with `attachment_lost`, uploads nothing, and removing it deletes the row", async () => {
    const storage = memoryStorage();
    const first = setup({ storage, reply: (c) => (c.step === "bytes" ? never() : undefined) });
    await first.client.ready;
    const { id } = first.client.attach("cs_1", file());
    await until(() => first.step("bytes").length === 1);
    first.client.close();

    const second = setup({ storage });
    await second.client.ready;
    expect(second.client.attachments().get()).toMatchObject([{ id, state: "failed", error: { code: "attachment_lost", reason: "the upload was interrupted: attach the file again" } }]);
    await expect(second.client.send("cs_1", "x", { attachments: [id] }).settled).rejects.toMatchObject({ code: "attachment_lost" });
    await sleep(20);
    expect(second.calls).toEqual([]);
    await second.client.removeAttachment(id);
    expect(second.calls.map((c) => c.step)).toEqual(["delete"]);
    expect(await storage.list("att/")).toEqual([]);
    second.client.close();
  });

  it("drops the records older than a day", async () => {
    const storage = memoryStorage();
    const day = 24 * 60 * 60 * 1000;
    const record = (id: string, at: number) => ({ id, sessionId: "cs_1", name: "a.png", mimetype: "image/png", bytes: 1, state: "ready", at });
    await storage.put("att/at_old", record("at_old", Date.now() - day - 1000));
    await storage.put("att/at_new", record("at_new", Date.now() - 1000));
    const { client } = setup({ storage });
    await client.ready;
    expect(client.attachments().get().map((a) => a.id)).toEqual(["at_new"]);
    client.close();
    await sleep(5);
    expect((await storage.list("att/")).map(([k]) => k)).toEqual(["att/at_new"]);
  });
});

describe("refusals", () => {
  it("marks a 413 failed with the server's reason before a byte is sent, and a message naming it fails unsent", async () => {
    const { client, step } = setup({ reply: (c) => (c.step === "create" ? json(413, { error: { code: "attachment_too_large", message: "a file can be at most 1 GB" } }) : undefined) });
    await client.ready;
    const { id, state } = client.attach("cs_1", file());
    await until(() => state.get().state === "failed");
    expect(state.get().error).toEqual({ code: "attachment_too_large", reason: "a file can be at most 1 GB" });
    expect(step("bytes")).toHaveLength(0);
    const failures: string[] = [];
    client.failures.subscribe((f) => failures.push(f.code));
    await expect(client.send("cs_1", "x", { attachments: [id] }).settled).rejects.toBeInstanceOf(Refused);
    expect(failures).toEqual(["attachment_too_large"]);
    expect(step("write")).toHaveLength(0);
    client.close();
  });

  it("treats the quota's 429 as a refusal, not a retry", async () => {
    const { client, step } = setup({ reply: (c) => (c.step === "create" ? json(429, { error: { code: "attachment_quota", message: "session over 1 GB" } }) : undefined) });
    await client.ready;
    const { state } = client.attach("cs_1", file());
    await until(() => state.get().state === "failed");
    expect(step("create")).toHaveLength(1);
    client.close();
  });

  it("fails on a 410 and tells the person to attach the file again", async () => {
    const { client, step } = setup({ reply: (c) => (c.step === "complete" ? json(410, { error: { code: "attachment_deleted" } }) : undefined) });
    await client.ready;
    const { state } = client.attach("cs_1", file());
    await until(() => state.get().state === "failed");
    expect(state.get().error).toEqual({ code: "attachment_deleted", reason: "the file expired before it was sent: attach it again" });
    expect(step("create")).toHaveLength(1);
    client.close();
  });

  it("marks the file failed when the server refuses the message for it (410 at send)", async () => {
    let bad = "";
    const { client, step, storage } = setup({
      reply: (c) => (c.step === "write" ? json(410, { error: { code: "attachment_deleted", message: "attachment deleted", attachmentId: bad } }) : undefined),
    });
    await client.ready;
    const a = client.attach("cs_1", file("a.png"));
    const b = client.attach("cs_1", file("b.png"));
    bad = b.id;
    const failures: string[] = [];
    client.failures.subscribe((f) => failures.push(f.code));
    await expect(client.send("cs_1", "x", { attachments: [a.id, b.id] }).settled).rejects.toMatchObject({ code: "attachment_deleted" });
    expect(failures).toEqual(["attachment_deleted"]);
    // Only the one the server named; both are still here for the composer to show.
    expect(a.state.get().state).toBe("ready");
    expect(b.state.get()).toMatchObject({ state: "failed", error: { code: "attachment_deleted", reason: "the file expired before it was sent: attach it again" } });
    // Sending the same chips again fails here, unsent.
    await expect(client.send("cs_1", "x", { attachments: [a.id, b.id] }).settled).rejects.toMatchObject({ code: "attachment_deleted" });
    expect(step("write")).toHaveLength(1);
    await sleep(5);
    expect((await storage.get(`att/${b.id}`)) as PendingAttachment).toMatchObject({ state: "failed" });
    client.close();
  });

  it("leaves the files alone when the message is refused for another reason", async () => {
    const { client } = setup({ reply: (c) => (c.step === "write" ? json(409, { error: { code: "session_archived", message: "archived" } }) : undefined) });
    await client.ready;
    const { id, state } = client.attach("cs_1", file());
    await expect(client.send("cs_1", "x", { attachments: [id] }).settled).rejects.toMatchObject({ code: "session_archived" });
    expect(state.get().state).toBe("ready");
    client.close();
  });

  it("refuses more than ten per message", async () => {
    const { client } = setup();
    await client.ready;
    expect(() => client.send("cs_1", "x", { attachments: Array.from({ length: 11 }, (_, i) => `at_${i}`) })).toThrow(Refused);
    client.close();
  });

  it("removing a chip stops the upload and deletes the row", async () => {
    const { client, calls, storage } = setup({ reply: (c) => (c.step === "bytes" ? never() : undefined) });
    await client.ready;
    const { id } = client.attach("cs_1", file());
    await until(() => calls.length === 2);
    expect(calls[1].init.signal?.aborted).toBe(false);
    await client.removeAttachment(id);
    expect(calls[1].init.signal?.aborted).toBe(true);
    expect(calls[2]).toMatchObject({ path: `/sessions/cs_1/attachments/${id}`, init: { method: "DELETE" } });
    expect(client.attachments().get()).toEqual([]);
    expect(await storage.list("att/")).toEqual([]);
    client.close();
  });
});

describe("attachmentUrl", () => {
  it("answers the signed URL and keeps it until shortly before it ends", async () => {
    let now = 1_000_000;
    let n = 0;
    const { client, step } = setup({
      now: () => now,
      reply: (c) => (c.step === "url" ? json(200, { url: `${STORE}at_ok?sig=${++n}`, expiresAt: new Date(now + 300_000).toISOString() }) : undefined),
    });
    await client.ready;
    const both = await Promise.all([client.attachmentUrl("cs_1", "at_ok"), client.attachmentUrl("cs_1", "at_ok")]);
    expect(both).toEqual([`${STORE}at_ok?sig=1`, `${STORE}at_ok?sig=1`]);
    expect(step("url").map((c) => c.path)).toEqual(["/sessions/cs_1/attachments/at_ok/url"]);
    now += 200_000;
    expect(await client.attachmentUrl("cs_1", "at_ok")).toBe(`${STORE}at_ok?sig=1`);
    expect(step("url")).toHaveLength(1);
    // A download is another URL.
    expect(await client.attachmentUrl("cs_1", "at_ok", { download: true })).toBe(`${STORE}at_ok?sig=2`);
    expect(step("url")[1].path).toBe("/sessions/cs_1/attachments/at_ok/url?disposition=attachment");
    // Near its end: asked again.
    now += 90_000;
    expect(await client.attachmentUrl("cs_1", "at_ok")).toBe(`${STORE}at_ok?sig=3`);
    client.close();
  });

  it("throws the refusal, and asks again the next time", async () => {
    const { client, step } = setup({ reply: (c) => (c.step === "url" ? json(404, { error: { code: "attachment_not_found" } }) : undefined) });
    await client.ready;
    await expect(client.attachmentUrl("cs_1", "at_gone")).rejects.toMatchObject({ code: "attachment_not_found" });
    await expect(client.attachmentUrl("cs_1", "at_gone")).rejects.toMatchObject({ code: "attachment_not_found" });
    expect(step("url")).toHaveLength(2);
    client.close();
  });
});

describe("a pending attachment", () => {
  it("is in `attachments()` for the store to draw", async () => {
    const { client } = setup({ reply: (c) => (c.step === "create" ? never() : undefined) });
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
