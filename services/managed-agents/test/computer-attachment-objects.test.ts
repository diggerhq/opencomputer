// The object route of the bucket store (work 126) in the Workers runtime, through the edge Worker,
// against Miniflare's R2: what the node tests of it (computer-api-http-attachment-objects.test.ts)
// take from a fake. The streamed lengths, the ranges and the mount ahead of the edge's own CORS.

import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { bucketAttachments } from "../src/attachments/store.js";
import worker from "../src/edge/index.js";

const KEY = "k".repeat(64);
const ORIGIN = "http://127.0.0.1:8080";
const bucket = (env as unknown as { ATTACHMENTS: R2Bucket }).ATTACHMENTS;
const store = bucketAttachments(bucket, { key: KEY, origin: ORIGIN });
const send = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), { ...env, ATTACHMENTS_URL_KEY: KEY } as never, createExecutionContext());
const streamed = (text: string): RequestInit => ({ method: "PUT", headers: { "content-type": "text/plain" }, body: new Response(text).body!, duplex: "half" }) as RequestInit;

describe("the object route on R2", () => {
  it("stores a streamed body of the signed length, and nothing of a shorter or a longer one", async () => {
    const key = "org_1/cs_0123456789abcdef/at_0000000000000001";
    const { url } = await store.uploadUrl(key, { bytes: 5, contentType: "text/plain" }, 60);
    for (const text of ["hell", "hello!"]) {
      const r = await send(url, streamed(text));
      await r.arrayBuffer();
      expect(r.status).toBe(400);
      expect(await store.head(key)).toBeNull();
    }
    const r = await send(url, streamed("hello"));
    await r.arrayBuffer();
    expect([r.status, r.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
    expect((await store.head(key))?.bytes).toBe(5);
    const empty = "org_1/cs_0123456789abcdef/at_0000000000000002";
    const zero = await send((await store.uploadUrl(empty, { bytes: 0, contentType: "text/plain" }, 60)).url, { method: "PUT", headers: { "content-type": "text/plain" } });
    await zero.arrayBuffer();
    expect([zero.status, (await store.head(empty))?.bytes]).toEqual([200, 0]);
  });

  it("serves it whole and by range with the signed headers, and its preflight keeps its CORS", async () => {
    const key = "org_1/cs_0123456789abcdef/at_0000000000000003";
    await bucket.put(key, "hello", { httpMetadata: { contentType: "text/html" } });
    const url = await store.downloadUrl(key, { contentType: "text/plain", disposition: "attachment; filename*=UTF-8''notes.txt" }, 60);
    const whole = await send(url);
    expect([whole.status, await whole.text(), whole.headers.get("content-type"), whole.headers.get("content-length")]).toEqual([200, "hello", "text/plain", "5"]);
    expect(whole.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.txt");
    expect(whole.headers.get("access-control-allow-origin")).toBe("*");
    const part = await send(url, { headers: { range: "bytes=1-3" } });
    expect([part.status, await part.text(), part.headers.get("content-range")]).toEqual([206, "ell", "bytes 1-3/5"]);
    const tail = await send(url, { headers: { range: "bytes=-2" } });
    expect([tail.status, await tail.text()]).toEqual([206, "lo"]);
    const head = await send(url, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length")]).toEqual([200, "5"]);
    const preflight = await send(url, { method: "OPTIONS", headers: { origin: "https://anywhere.example", "access-control-request-method": "PUT" } });
    expect([preflight.status, preflight.headers.get("access-control-allow-origin"), preflight.headers.get("access-control-allow-headers")]).toEqual([204, "*", "content-type, range"]);
    const forged = await send(url.replace(/sig=../, "sig=00"));
    await forged.arrayBuffer();
    expect(forged.status).toBe(403);
  });

  it("is not there without the key: the edge answers as it does any other path", async () => {
    const url = await store.downloadUrl("org_1/cs_0123456789abcdef/at_0000000000000003", { contentType: "text/plain", disposition: "inline" }, 60);
    const r = await worker.fetch(new Request(url), env as never, createExecutionContext());
    await r.arrayBuffer();
    expect(r.status).toBe(404);
  });
});
