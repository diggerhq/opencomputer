// The bucket store of attachments (work 126) and its object route: the store a deployment without
// an S3 endpoint has (the self-host). Its URLs are our own, signed by us; the route takes and serves
// the bytes on the signature alone. The bucket is an R2 binding in memory; Org is a fake.

import { describe, expect, it, vi } from "vitest";

import { attachmentsOf, bucketAttachments, OBJECT_ROUTE } from "../src/attachments/store.js";
import type { Principal } from "../src/auth/principal.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { callerOrigin, rangeOf, routeAttachmentObject } from "../src/http/api/attachment-objects.js";
import { routeComputerApi } from "../src/http/api/dispatch.js";

const KEY = "k".repeat(64);
const ORIGIN = "https://computer.example";
const OBJECT = "org_1/cs_0123456789abcdef/at_0123456789abcdef";
const TEXT = new TextEncoder().encode("hello");
const S3 = { ATTACHMENTS_S3_ENDPOINT: "https://s3.test", ATTACHMENTS_S3_BUCKET: "b", ATTACHMENTS_S3_ACCESS_KEY_ID: "id", ATTACHMENTS_S3_SECRET_ACCESS_KEY: "secret" };

/** An R2 bucket in memory: what the store and the route ask of one. */
function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const meta = (o: { bytes: Uint8Array }) => ({ size: o.bytes.length, httpEtag: `"etag-${o.bytes.length}"` });
  return {
    objects,
    put: vi.fn(async (key: string, body: ReadableStream | Uint8Array, opts: { httpMetadata: { contentType: string } }) => {
      const o = { bytes: new Uint8Array(await new Response(body).arrayBuffer()), contentType: opts.httpMetadata.contentType };
      objects.set(key, o);
      return meta(o);
    }),
    head: vi.fn(async (key: string) => (objects.has(key) ? meta(objects.get(key)!) : null)),
    get: vi.fn(async (key: string, opts?: { range?: { offset: number; length: number } }) => {
      const o = objects.get(key);
      if (!o) return null;
      const r = opts?.range;
      return { ...meta(o), body: new Response(r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes).body! };
    }),
    delete: vi.fn(async (keys: string | string[]) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => objects.delete(k))),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false })),
  };
}

function setup() {
  const b = bucket();
  const env = { ATTACHMENTS: b, ATTACHMENTS_URL_KEY: KEY } as never;
  const store = bucketAttachments(b as never, { key: KEY, origin: ORIGIN });
  const send = async (url: string | URL, init: RequestInit = {}) => (await routeAttachmentObject(new Request(url, init), env))!;
  const uploadUrl = (bytes = 5, contentType = "text/plain", expiresS = 60) => store.uploadUrl(OBJECT, { bytes, contentType }, expiresS);
  const downloadUrl = (disposition = "attachment; filename*=UTF-8''notes.txt", expiresS = 60) => store.downloadUrl(OBJECT, { contentType: "text/plain", disposition }, expiresS);
  const stored = () => b.objects.set(OBJECT, { bytes: TEXT, contentType: "text/plain" });
  return { b, env, store, send, uploadUrl, downloadUrl, stored };
}

describe("attachmentsOf: which store an env has", () => {
  const b = bucket() as never;
  it("is S3 when its four values are set, even beside a bucket", async () => {
    const store = attachmentsOf({ ...S3, ATTACHMENTS: b, ATTACHMENTS_URL_KEY: KEY }, ORIGIN)!;
    expect((await store.uploadUrl(OBJECT, { bytes: 5, contentType: "text/plain" }, 60)).url).toMatch(/^https:\/\/s3\.test\/b\/org_1\/.*X-Amz-Signature=/);
  });

  it("is the bucket when it and its key are bound and S3 is not whole; its URLs are on the caller's origin", async () => {
    const { ATTACHMENTS_S3_BUCKET: _, ...partial } = S3;
    const store = attachmentsOf({ ...partial, ATTACHMENTS: b, ATTACHMENTS_URL_KEY: KEY }, `${ORIGIN}/`)!;
    const { url, headers } = await store.uploadUrl(OBJECT, { bytes: 5, contentType: "text/plain" }, 60);
    expect(url.split("?")[0]).toBe(`${ORIGIN}${OBJECT_ROUTE}/${OBJECT}`);
    expect(headers).toEqual({ "content-type": "text/plain" });
  });

  it("is none without the key or without the bucket", () => {
    expect(attachmentsOf({ ATTACHMENTS: b })).toBeNull();
    expect(attachmentsOf({ ATTACHMENTS_URL_KEY: KEY })).toBeNull();
    expect(attachmentsOf({})).toBeNull();
  });

  it("without an origin (Org, capabilities) still reads and deletes, and only cannot make a URL", async () => {
    const mem = bucket();
    mem.objects.set(OBJECT, { bytes: TEXT, contentType: "text/plain" });
    mem.objects.set("org_1/cs_other/at_1", { bytes: TEXT, contentType: "text/plain" });
    const store = attachmentsOf({ ATTACHMENTS: mem as never, ATTACHMENTS_URL_KEY: KEY })!;
    expect(await store.head(OBJECT)).toEqual({ bytes: 5, etag: '"etag-5"' });
    expect(await store.head("org_1/none/at_0")).toBeNull();
    await store.removeAll("org_1/cs_0123456789abcdef/");
    expect([...mem.objects.keys()]).toEqual(["org_1/cs_other/at_1"]);
    await store.delete("org_1/cs_other/at_1");
    expect(mem.objects.size).toBe(0);
    await expect(store.uploadUrl(OBJECT, { bytes: 5, contentType: "text/plain" }, 60)).rejects.toThrow(/origin/);
  });
});

describe("PUT of a signed upload URL", () => {
  const put = (body: BodyInit, type = "text/plain"): RequestInit => ({ method: "PUT", headers: { "content-type": type }, body });

  it("stores exactly the signed bytes under the signed type, with no credential: 200", async () => {
    const { b, send, uploadUrl, store } = setup();
    const { url, headers } = await uploadUrl();
    const r = await send(url, { method: "PUT", headers, body: TEXT });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(b.objects.get(OBJECT)).toEqual({ bytes: TEXT, contentType: "text/plain" });
    expect(await store.head(OBJECT)).toEqual({ bytes: 5, etag: '"etag-5"' });
  });

  it("refuses a tampered URL (403): another object, size, type, expiry or signature", async () => {
    const { b, send, uploadUrl } = setup();
    const { url } = await uploadUrl();
    const changed = (edit: (u: URL) => void) => {
      const u = new URL(url);
      edit(u);
      return u;
    };
    const tampered = [
      changed((u) => (u.pathname = u.pathname.replace("at_0123456789abcdef", "at_fedcba9876543210"))),
      changed((u) => u.searchParams.set("bytes", "6")),
      changed((u) => u.searchParams.set("type", "text/html")),
      changed((u) => u.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 3600))),
      changed((u) => u.searchParams.set("sig", "0".repeat(64))),
      changed((u) => u.searchParams.set("sig", "nope")),
      changed((u) => u.searchParams.delete("sig")),
    ];
    for (const u of tampered) expect((await send(u, put(u.searchParams.get("bytes") === "6" ? "hello!" : TEXT, u.searchParams.get("type")!))).status).toBe(403);
    // Signed with another key.
    const other = await bucketAttachments(b as never, { key: "x".repeat(64), origin: ORIGIN }).uploadUrl(OBJECT, { bytes: 5, contentType: "text/plain" }, 60);
    expect((await send(other.url, put(TEXT))).status).toBe(403);
    expect(b.put).not.toHaveBeenCalled();
  });

  it("refuses an expired URL (403): the uploader asks for a new one", async () => {
    const { b, send, uploadUrl } = setup();
    const { url } = await uploadUrl(5, "text/plain", -1);
    const r = await send(url, put(TEXT));
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(b.objects.size).toBe(0);
  });

  it("refuses another content-type (400) and stores nothing", async () => {
    const { b, send, uploadUrl } = setup();
    const { url } = await uploadUrl();
    expect((await send(url, put(TEXT, "text/html"))).status).toBe(400);
    expect((await send(url, { method: "PUT", body: new Blob([TEXT]) })).status).toBe(400);
    expect(b.put).not.toHaveBeenCalled();
  });

  it("refuses a short or a long body (400) and stores nothing, with or without a content-length", async () => {
    const { b, send, uploadUrl } = setup();
    const { url } = await uploadUrl();
    const streamed = (text: string): RequestInit => ({ ...put(new Response(text).body!), duplex: "half" }) as RequestInit;
    for (const text of ["hell", "hello!", ""]) {
      expect((await send(url, put(text))).status).toBe(400);
      expect((await send(url, streamed(text))).status).toBe(400);
    }
    // The fake bucket would keep whatever it read: a failed stream must not have reached the end of a put.
    expect(b.objects.size).toBe(0);
    expect((await send(url, streamed("hello"))).status).toBe(200);
  });

  it("takes an empty file", async () => {
    const { b, send, uploadUrl } = setup();
    const { url } = await uploadUrl(0);
    expect((await send(url, { method: "PUT", headers: { "content-type": "text/plain" } })).status).toBe(200);
    expect(b.objects.get(OBJECT)!.bytes.length).toBe(0);
  });

  it("does not take a download URL, nor a GET of an upload URL", async () => {
    const { send, uploadUrl, downloadUrl, stored } = setup();
    stored();
    expect((await send(await downloadUrl(), put(TEXT))).status).toBe(403);
    expect((await send((await uploadUrl()).url)).status).toBe(403);
    expect((await send((await uploadUrl()).url, { method: "DELETE" })).status).toBe(405);
  });
});

describe("GET of a signed download URL", () => {
  it("serves the object with the signed type and disposition, nosniff, cacheable, to any origin", async () => {
    const { send, downloadUrl, stored } = setup();
    stored();
    const disposition = "inline; filename*=UTF-8''caf%C3%A9%20%231.txt";
    const r = await send(await downloadUrl(disposition));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("hello");
    expect(Object.fromEntries(r.headers.entries())).toMatchObject({
      "content-type": "text/plain",
      "content-disposition": disposition,
      "content-length": "5",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
      etag: '"etag-5"',
    });
  });

  it("serves the signed type, whatever the uploader's object says", async () => {
    const { b, send, downloadUrl } = setup();
    b.objects.set(OBJECT, { bytes: TEXT, contentType: "text/html" });
    expect((await send(await downloadUrl())).headers.get("content-type")).toBe("text/plain");
  });

  it("refuses a tampered disposition or type and an expired URL (403), and has no object to give (404)", async () => {
    const { send, downloadUrl, stored } = setup();
    const url = new URL(await downloadUrl());
    expect((await send(url)).status).toBe(404);
    stored();
    for (const [name, value] of [["disposition", "inline"], ["type", "text/html"], ["op", "put"]]) {
      const u = new URL(url);
      u.searchParams.set(name!, value!);
      expect((await send(u)).status).toBe(403);
    }
    expect((await send(await downloadUrl("inline", -1))).status).toBe(403);
  });

  it("serves one Range (206), the end of the object, and refuses one outside it (416)", async () => {
    const { send, downloadUrl, stored } = setup();
    stored();
    const url = await downloadUrl();
    const ranged = async (range: string) => {
      const r = await send(url, { headers: { range } });
      return [r.status, await r.text(), r.headers.get("content-range"), r.headers.get("content-length")];
    };
    expect(await ranged("bytes=1-3")).toEqual([206, "ell", "bytes 1-3/5", "3"]);
    expect(await ranged("bytes=3-")).toEqual([206, "lo", "bytes 3-4/5", "2"]);
    expect(await ranged("bytes=-2")).toEqual([206, "lo", "bytes 3-4/5", "2"]);
    expect(await ranged("bytes=2-99")).toEqual([206, "llo", "bytes 2-4/5", "3"]);
    expect(await ranged("bytes=0-1,3-4")).toEqual([200, "hello", null, "5"]);
    const outside = await send(url, { headers: { range: "bytes=5-" } });
    expect([outside.status, outside.headers.get("content-range")]).toEqual([416, "bytes */5"]);
    expect(rangeOf("bytes=-0", 5)).toBe("unsatisfiable");
    expect(rangeOf("items=0-1", 5)).toBe("whole");
  });

  it("answers HEAD without a body, and the preflight for any origin", async () => {
    const { b, send, downloadUrl, stored } = setup();
    stored();
    const url = await downloadUrl();
    const head = await send(url, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, "5", ""]);
    expect(b.get).not.toHaveBeenCalled();
    const preflight = await send(url, { method: "OPTIONS", headers: { origin: "https://anywhere.example", "access-control-request-method": "PUT", "access-control-request-headers": "content-type" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type, range");
  });
});

describe("where the route is", () => {
  it("is not there on other paths, nor on a deployment without the bucket and its key", async () => {
    const { env, uploadUrl } = setup();
    const { url } = await uploadUrl();
    expect(await routeAttachmentObject(new Request(`${ORIGIN}/v1/computer/sessions`), env)).toBeNull();
    expect(await routeAttachmentObject(new Request(`${ORIGIN}${OBJECT_ROUTE}`), env)).toBeNull();
    expect(await routeAttachmentObject(new Request(url), { ATTACHMENTS_URL_KEY: KEY })).toBeNull();
    expect(await routeAttachmentObject(new Request(url), { ...S3 })).toBeNull();
  });
});

describe("callerOrigin: the origin a URL is handed back on", () => {
  const env = { COMPUTER_PUBLIC_ORIGIN: "https://computer.example" };
  const from = (url: string, forwarded?: string) => callerOrigin(new Request(url, forwarded === undefined ? {} : { headers: { "x-opencomputer-public-origin": forwarded } }), env);

  it("is what api-edge says its caller reached, else the request's own, else the public origin for the internal name", () => {
    expect(from("https://managed-agents.selfhost/v1/computer/sessions", "http://192.168.1.5:8080")).toBe("http://192.168.1.5:8080");
    expect(from("http://127.0.0.1:8080/v1/computer/sessions")).toBe("http://127.0.0.1:8080");
    expect(from("https://managed-agents.selfhost/v1/computer/sessions")).toBe("https://computer.example");
    expect(callerOrigin(new Request("https://managed-agents.selfhost/v1/x"), {})).toBe("https://managed-agents.selfhost");
  });

  it("takes only an http(s) origin from the header", () => {
    for (const bad of ["javascript:alert(1)", "https://a.example/path", "https://user:pw@a.example", "ftp://a.example", "a.example", ""]) {
      expect(from("http://127.0.0.1:8080/v1/computer/sessions", bad)).toBe("http://127.0.0.1:8080");
    }
  });
});

describe("end to end through the API's routes: create, PUT, complete, url, GET", () => {
  const ORG = "org_1";
  const SID = "cs_0123456789abcdef";
  const AT = "at_0123456789abcdef";
  const MEMBER = "usr_01jabcdefghjkmnpqrstvwxyz0";
  const principal: Principal = {
    org: ORG, subject: MEMBER, kind: "member", via: "dashboard", scopes: ["sessions:read", "sessions:write"],
    audiences: ["org", `member:${MEMBER}`], admin: false, credential: { id: "login:u", expiresAt: null },
  };
  const identity = { kind: "user", userId: "u", accountId: ORG, organizationId: ORG, ocPrincipal: principal } as RequestIdentity;

  it("uploads to and reads from the gateway's own signed URLs", async () => {
    const b = bucket();
    let row = { id: AT, sessionId: SID, by: `user:${MEMBER}`, name: "notes.txt", mimetype: "text/plain", bytes: 5, state: "uploading", etag: null as string | null, createdAt: "2026-01-01T00:00:00.000Z", attachedTo: null };
    const org = {
      attachmentCreate: vi.fn(async () => ({ ok: true, created: true, attachment: row })),
      attachmentRead: vi.fn(async () => ({ ok: true, attachment: row })),
      attachmentReady: vi.fn(async (_id: string, etag: string) => ({ ok: true, attachment: (row = { ...row, state: "ready", etag }) })),
    };
    const ns = (make: () => unknown) => ({ getByName: () => make() });
    // A call that came through api-edge's internal name: the public origin is the deployment's.
    const env = { ORGS: ns(() => org), SESSION_LOG: ns(() => ({})), COMPUTERS: ns(() => ({})), ATTACHMENTS: b, ATTACHMENTS_URL_KEY: KEY, COMPUTER_PUBLIC_ORIGIN: ORIGIN } as never;
    const api = async (method: string, path: string, body?: unknown) => {
      const url = new URL(`https://managed-agents.selfhost/v1/computer${path}`);
      const request = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const r = await routeComputerApi(request, env, identity, ORG, { computerApi: vi.fn() }, url.pathname.slice("/v1/computer".length));
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    const path = `/sessions/${SID}/attachments/${AT}`;

    const made = await api("PUT", path, { name: "notes.txt", mimetype: "text/plain", bytes: 5 });
    expect(made.status).toBe(201);
    const { url, method, headers } = made.body.upload;
    expect(url.split("?")[0]).toBe(`${ORIGIN}${OBJECT_ROUTE}/${ORG}/${SID}/${AT}`);

    expect((await api("POST", `${path}/complete`)).status).toBe(409);
    const sent = await routeAttachmentObject(new Request(url, { method, headers, body: TEXT }), env);
    expect(sent!.status).toBe(200);
    const done = await api("POST", `${path}/complete`);
    expect([done.status, done.body.attachment.state]).toEqual([200, "ready"]);

    const link = await api("GET", `${path}/url`);
    expect(link.status).toBe(200);
    const got = await routeAttachmentObject(new Request(link.body.url), env);
    expect([got!.status, await got!.text(), got!.headers.get("content-type")]).toEqual([200, "hello", "text/plain"]);
    expect(got!.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.txt");
  });
});
