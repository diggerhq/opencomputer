// The attachment routes (work 126, section 4) through the API's dispatch: the row from the body and
// a signed URL that takes the file, the check of what arrived, a signed URL that serves it, and a
// turn's `attachments` named in Org before the accept. Org is a fake; the store is an S3 endpoint
// that `fetch` is stubbed to be. No route reads or writes an attachment's bytes.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "../src/auth/principal.js";
import { routeComputerApi, type ComputerApiStub } from "../src/http/api/dispatch.js";
import { ATTACHMENT_BYTES_MAX } from "../src/http/api/attachment-routes.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { firstTurnId } from "../src/ids/session-ids.js";

const ORG = "org_1";
const USER = "user_01JABCDEFGHJKMNPQRSTVWXYZ0";
const MEMBER = "usr_01jabcdefghjkmnpqrstvwxyz0";
const SID = "cs_0123456789abcdef";
const OTHER = "cs_fedcba9876543210";
const AT = "at_0123456789abcdef";
const AT2 = "at_fedcba9876543210";

const memberP: Principal = {
  org: ORG, subject: MEMBER, kind: "member", via: "dashboard",
  scopes: ["sessions:read", "sessions:write", "asks:answer", "work:read", "work:write"],
  audiences: ["org", `member:${MEMBER}`], admin: false, credential: { id: `login:${USER}`, expiresAt: null },
};
const member = { kind: "user", userId: USER, accountId: ORG, organizationId: ORG, ocPrincipal: memberP } as RequestIdentity;
const key = (scopes: string[]) =>
  ({
    ...member,
    apiKey: { id: "key_1", hash: "a".repeat(64), name: "k", kind: "user", scopes, expiresAt: "2030-01-01T00:00:00.000Z", createdAt: null },
    ocPrincipal: { ...memberP, kind: "key", via: "api", scopes: scopes as Principal["scopes"], credential: { id: "key_1", expiresAt: Date.parse("2030-01-01T00:00:00.000Z") } },
  }) as RequestIdentity;
const agent = {
  ...member,
  apiKey: { id: "key_2", hash: "b".repeat(64), name: "s", kind: "user", scopes: ["sessions:read", "sessions:write"], expiresAt: null, createdAt: null },
  ocPrincipal: {
    org: ORG, subject: SID, kind: "agent", via: "agent", session: SID,
    scopes: ["sessions:read", "sessions:write", "work:read", "work:write"], audiences: [], admin: false,
    credential: { id: "key_2", expiresAt: null },
  },
} as RequestIdentity;

const ns = (make: (name: string) => unknown) => ({ getByName: vi.fn((name: string) => make(name)) });
const row = (id = SID) => ({ id, title: "t", lastSeq: 3, status: "idle", settings: { model: null, effort: null, mode: "default", speed: null }, asks: [], queued: [], subagents: [] });
const attachment = (over: Record<string, unknown> = {}) => ({
  id: AT, sessionId: SID, by: `user:${MEMBER}`, name: "notes.txt", mimetype: "text/plain", bytes: 5, state: "ready", etag: '"e1"', createdAt: "2026-01-01T00:00:00.000Z", attachedTo: null, ...over,
});
const refusal = (code: string, status: number, more: Record<string, unknown> = {}) => ({ ok: false, code, status, ...more });

const S3 = { ATTACHMENTS_S3_ENDPOINT: "https://store.test", ATTACHMENTS_S3_BUCKET: "files", ATTACHMENTS_S3_ACCESS_KEY_ID: "AKIDEXAMPLE", ATTACHMENTS_S3_SECRET_ACCESS_KEY: "secret" };
const OBJECT = `https://store.test/files/${ORG}/${SID}/${AT}`;

/** The store's own requests (HEAD, DELETE): `objects` is what it holds, by URL without the query. */
function store(objects: Record<string, { bytes: number; etag: string }> = {}) {
  const calls: [string, string][] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const at = `${url.origin}${url.pathname}`;
    const method = init?.method ?? "GET";
    calls.push([method, at]);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const o = objects[at];
    if (method === "DELETE") {
      delete objects[at];
      return new Response(null, { status: 204 });
    }
    if (!o) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: { "content-length": String(o.bytes), etag: o.etag } });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, objects, fetcher };
}
afterEach(() => vi.unstubAllGlobals());

interface Fakes {
  org?: Record<string, unknown>;
  log?: Record<string, unknown>;
  computer?: Record<string, unknown>;
  /** false: a deployment without a store. */
  s3?: boolean;
}

function setup(f: Fakes) {
  const env = {
    ORGS: ns(() => f.org ?? {}),
    SESSION_LOG: ns(() => f.log ?? {}),
    COMPUTERS: ns(() => f.computer ?? {}),
    ...(f.s3 === false ? {} : S3),
  };
  const stub: ComputerApiStub = { computerApi: vi.fn() };
  const call = async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; identity?: RequestIdentity } = {}) => {
    const url = new URL(`https://blue.test/v1/computer${path}`);
    const res = await routeComputerApi(
      new Request(url, { method, headers: { "content-type": "application/json", ...opts.headers }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }),
      env as never,
      opts.identity ?? member,
      ORG,
      stub,
      url.pathname.slice("/v1/computer".length),
    );
    const text = await res.text();
    const json = res.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : null;
    return { status: res.status, body: json, text, headers: Object.fromEntries(res.headers.entries()) };
  };
  return { env, call, stub };
}

/** The upload's body: a 5-byte text file named notes.txt. */
const upload = (over: Record<string, unknown> = {}) => ({ name: "notes.txt", mimetype: "text/plain", bytes: 5, ...over });
const signedHeaders = (url: string) => new URL(url).searchParams.get("X-Amz-SignedHeaders");

describe("PUT /sessions/{sid}/attachments/{id} (section 4)", () => {
  const uploading = attachment({ state: "uploading", etag: null });
  const org = () => ({ attachmentCreate: vi.fn(async () => ({ ok: true, created: true, attachment: uploading })) });

  it("makes the row from the body and answers a signed PUT of the object under the org/session/id key: 201, no byte through us", async () => {
    const o = org();
    const s = store();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload() });
    expect(r.status).toBe(201);
    expect(r.body.attachment).toEqual(uploading);
    expect(o.attachmentCreate).toHaveBeenCalledWith(memberP, SID, AT, { name: "notes.txt", mimetype: "text/plain", bytes: 5 });
    const { url, method, headers, expiresAt } = r.body.upload;
    expect([method, headers]).toEqual(["PUT", { "content-type": "text/plain" }]);
    expect(url.split("?")[0]).toBe(OBJECT);
    // The declared size and type are part of the grant: the store refuses a request with others.
    expect(signedHeaders(url)).toBe("content-length;content-type;host");
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("answers the same row again with a new URL while it uploads (200), and without one once it is stored", async () => {
    store();
    const again = { attachmentCreate: vi.fn(async () => ({ ok: true, created: false, attachment: uploading })) };
    const r = await setup({ org: again }).call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload() });
    expect([r.status, r.body.upload.method]).toEqual([200, "PUT"]);
    const done = { attachmentCreate: vi.fn(async () => ({ ok: true, created: false, attachment: attachment() })) };
    const d = await setup({ org: done }).call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload() });
    expect(d.status).toBe(200);
    expect(d.body).toEqual({ attachment: attachment() });
  });

  it("takes the media type without its parameters; a key with sessions:write may, a read key may not", async () => {
    const o = org();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload({ name: "résumé +.txt", mimetype: "Text/Plain; charset=utf-8" }), identity: key(["sessions:write"]) });
    expect(r.status).toBe(201);
    expect(o.attachmentCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: "key" }), SID, AT, { name: "résumé +.txt", mimetype: "text/plain", bytes: 5 });
    expect((await call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload(), identity: key(["sessions:read"]) })).status).toBe(403);
  });

  it.each([
    ["no mimetype", upload({ mimetype: undefined }), "mimetype"],
    ["a mimetype that is not a media type", upload({ mimetype: "plain" }), "mimetype"],
    ["no bytes", upload({ bytes: undefined }), "bytes"],
    ["bytes that are not a whole number", upload({ bytes: 1.5 }), "bytes"],
    ["negative bytes", upload({ bytes: -1 }), "bytes"],
    ["no name", upload({ name: undefined }), "name"],
    ["a name with a path", upload({ name: "../x.txt" }), "name"],
    ["a name of control characters", upload({ name: "a\u0000b" }), "name"],
  ])("refuses %s before Org is asked: 400 invalid_request", async (_what, body, field) => {
    const o = org();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}`, { body });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: "invalid_request", field } });
    expect(o.attachmentCreate).not.toHaveBeenCalled();
  });

  it("refuses a size past the limit before the row: 413 attachment_too_large with the limit", async () => {
    const o = org();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload({ bytes: ATTACHMENT_BYTES_MAX + 1 }) });
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ error: { code: "attachment_too_large", max: ATTACHMENT_BYTES_MAX } });
    expect(o.attachmentCreate).not.toHaveBeenCalled();
    expect((await call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload({ bytes: ATTACHMENT_BYTES_MAX }) })).status).toBe(201);
  });

  it("answers Org's refusal with its status and no URL", async () => {
    for (const [code, status] of [["session_not_found", 404], ["forbidden", 403], ["attachment_quota", 429], ["content_mismatch", 400], ["attachment_deleted", 410]] as const) {
      const o = { attachmentCreate: vi.fn(async () => refusal(code, status)) };
      const r = await setup({ org: o }).call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload() });
      expect([r.status, r.body.error.code]).toEqual([status, code]);
      expect(r.body).not.toHaveProperty("upload");
    }
  });

  it("answers 503 unavailable on a deployment without a store, before any row holds quota", async () => {
    const o = org();
    const r = await setup({ org: o, s3: false }).call("PUT", `/sessions/${SID}/attachments/${AT}`, { body: upload() });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: { code: "unavailable", retryAfterMs: 5000 } });
    expect(o.attachmentCreate).not.toHaveBeenCalled();
  });

  it("names no attachment for an id of another shape, and no route for POST or the old content path", async () => {
    const o = org();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/at_nope`, { body: upload() });
    expect([r.status, r.body.error.code]).toEqual([404, "attachment_not_found"]);
    expect((await call("POST", `/sessions/${SID}/attachments`, { body: {} })).status).toBe(404);
    expect((await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { body: upload() })).status).toBe(404);
    expect((await call("GET", `/sessions/${SID}/attachments/${AT}/content`)).status).toBe(404);
    expect(o.attachmentCreate).not.toHaveBeenCalled();
  });
});

describe("POST /sessions/{sid}/attachments/{id}/complete", () => {
  const uploading = attachment({ state: "uploading", etag: null });
  const org = () => ({
    attachmentRead: vi.fn(async () => ({ ok: true, attachment: uploading })),
    attachmentReady: vi.fn(async (_id: string, etag: string) => ({ ok: true, attachment: attachment({ etag }) })),
  });

  it("asks the store for the object and marks the row ready with its etag: 200", async () => {
    const o = org();
    const s = store({ [OBJECT]: { bytes: 5, etag: '"e5"' } });
    const r = await setup({ org: o }).call("POST", `/sessions/${SID}/attachments/${AT}/complete`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ attachment: attachment({ etag: '"e5"' }) });
    expect(s.calls).toEqual([["HEAD", OBJECT]]);
    expect(o.attachmentReady).toHaveBeenCalledWith(AT, '"e5"');
  });

  it("is the same answer again for a row already stored, the store not asked", async () => {
    const o = { ...org(), attachmentRead: vi.fn(async () => ({ ok: true, attachment: attachment({ state: "attached" }) })) };
    const s = store();
    const r = await setup({ org: o }).call("POST", `/sessions/${SID}/attachments/${AT}/complete`);
    expect([r.status, r.body.attachment.state]).toEqual([200, "attached"]);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(o.attachmentReady).not.toHaveBeenCalled();
  });

  it("refuses when the object is not there: 409 attachment_not_uploaded", async () => {
    const o = org();
    store();
    const r = await setup({ org: o }).call("POST", `/sessions/${SID}/attachments/${AT}/complete`);
    expect([r.status, r.body.error.code, r.body.error.attachmentId]).toEqual([409, "attachment_not_uploaded", AT]);
    expect(o.attachmentReady).not.toHaveBeenCalled();
  });

  it("deletes an object of another size than declared: 400 content_mismatch, nothing marked ready", async () => {
    const o = org();
    const s = store({ [OBJECT]: { bytes: 6, etag: '"e6"' } });
    const r = await setup({ org: o }).call("POST", `/sessions/${SID}/attachments/${AT}/complete`);
    expect([r.status, r.body.error.code]).toEqual([400, "content_mismatch"]);
    expect(s.calls).toEqual([["HEAD", OBJECT], ["DELETE", OBJECT]]);
    expect(o.attachmentReady).not.toHaveBeenCalled();
  });

  it("deletes the object of a row deleted while it uploaded: 410", async () => {
    const s = store({ [OBJECT]: { bytes: 5, etag: '"e5"' } });
    const gone = { attachmentRead: vi.fn(async () => refusal("attachment_deleted", 410)) };
    expect((await setup({ org: gone }).call("POST", `/sessions/${SID}/attachments/${AT}/complete`)).status).toBe(410);
    expect(s.calls).toEqual([["DELETE", OBJECT]]);
    // Deleted between the read and the ready: the same.
    const t = store({ [OBJECT]: { bytes: 5, etag: '"e5"' } });
    const late = { ...org(), attachmentReady: vi.fn(async () => refusal("attachment_deleted", 410)) };
    expect((await setup({ org: late }).call("POST", `/sessions/${SID}/attachments/${AT}/complete`)).status).toBe(410);
    expect(t.calls).toEqual([["HEAD", OBJECT], ["DELETE", OBJECT]]);
  });

  it("answers 503 when the store fails, what Org refuses, and 403 to a read key", async () => {
    const o = org();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const failed = await setup({ org: o }).call("POST", `/sessions/${SID}/attachments/${AT}/complete`);
    expect([failed.status, failed.body.error.code]).toEqual([503, "unavailable"]);
    expect(o.attachmentReady).not.toHaveBeenCalled();
    const refused = setup({ org: { attachmentRead: vi.fn(async () => refusal("attachment_not_found", 404)) } });
    expect((await refused.call("POST", `/sessions/${SID}/attachments/${AT}/complete`)).status).toBe(404);
    expect((await refused.call("POST", `/sessions/${SID}/attachments/${AT}/complete`, { identity: key(["sessions:read"]) })).status).toBe(403);
  });
});

describe("GET /sessions/{sid}/attachments and /{id}", () => {
  it("lists and reads through Org as the caller; the session's agent reads its own", async () => {
    const org = {
      attachmentList: vi.fn(async () => ({ ok: true, attachments: [attachment()] })),
      attachmentRead: vi.fn(async () => ({ ok: true, attachment: attachment() })),
    };
    const { call } = setup({ org });
    expect(await call("GET", `/sessions/${SID}/attachments`)).toMatchObject({ status: 200, body: { attachments: [attachment()] } });
    expect(org.attachmentList).toHaveBeenCalledWith(memberP, SID);
    expect(await call("GET", `/sessions/${SID}/attachments/${AT}`, { identity: agent })).toMatchObject({ status: 200, body: { attachment: attachment() } });
    expect(org.attachmentRead).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent", session: SID }), SID, AT);
    expect((await call("GET", `/sessions/${SID}/attachments`, { identity: key(["work:read"]) })).status).toBe(403);
  });

  it("answers Org's not found and deleted", async () => {
    const org = {
      attachmentRead: vi.fn(async () => refusal("attachment_deleted", 410)),
      attachmentList: vi.fn(async () => refusal("session_not_found", 404)),
    };
    const { call } = setup({ org });
    expect((await call("GET", `/sessions/${SID}/attachments/${AT}`)).status).toBe(410);
    expect((await call("GET", `/sessions/${SID}/attachments`)).status).toBe(404);
  });
});

describe("GET /sessions/{sid}/attachments/{id}/url", () => {
  const stored = (over: Record<string, unknown> = {}) => {
    const s = store();
    const org = { attachmentRead: vi.fn(async () => ({ ok: true, attachment: attachment(over) })) };
    return { ...setup({ org }), org, s };
  };
  const signed = (url: string) => Object.fromEntries(new URL(url).searchParams.entries());

  it("answers a signed GET of the object, served with the row's type as an attachment and cacheable; the store not asked", async () => {
    const { call, s } = stored();
    const r = await call("GET", `/sessions/${SID}/attachments/${AT}/url`);
    expect(r.status).toBe(200);
    expect(r.body.url.split("?")[0]).toBe(OBJECT);
    expect(signed(r.body.url)).toMatchObject({
      "response-content-type": "text/plain",
      "response-content-disposition": "attachment; filename*=UTF-8''notes.txt",
      "response-cache-control": "private, max-age=31536000, immutable",
      "X-Amz-Expires": "300",
      "X-Amz-SignedHeaders": "host",
    });
    expect(Date.parse(r.body.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("serves raster images inline unless a download is asked for, everything else as an attachment, the name percent-encoded", async () => {
    for (const [mimetype, name, query, disposition] of [
      ["image/png", "shot.png", "", "inline; filename*=UTF-8''shot.png"],
      ["image/png", "shot.png", "?disposition=attachment", "attachment; filename*=UTF-8''shot.png"],
      ["image/svg+xml", "logo.svg", "", "attachment; filename*=UTF-8''logo.svg"],
      ["text/html", "a b's.html", "", "attachment; filename*=UTF-8''a%20b%27s.html"],
      ["application/pdf", "doc.pdf", "", "attachment; filename*=UTF-8''doc.pdf"],
    ]) {
      const { call } = stored({ mimetype, name });
      const r = await call("GET", `/sessions/${SID}/attachments/${AT}/url${query}`);
      expect([r.status, signed(r.body.url)["response-content-type"], signed(r.body.url)["response-content-disposition"]]).toEqual([200, mimetype, disposition]);
    }
  });

  it("the session's agent and a read key may; one still uploading is 409, what Org refuses is its answer, no store is 503", async () => {
    const { call, org } = stored({ state: "attached" });
    expect((await call("GET", `/sessions/${SID}/attachments/${AT}/url`, { identity: agent })).status).toBe(200);
    expect(org.attachmentRead).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent", session: SID }), SID, AT);
    expect((await call("GET", `/sessions/${SID}/attachments/${AT}/url`, { identity: key(["sessions:read"]) })).status).toBe(200);
    const u = await stored({ state: "uploading", etag: null }).call("GET", `/sessions/${SID}/attachments/${AT}/url`);
    expect([u.status, u.body.error.code]).toEqual([409, "attachment_not_ready"]);
    const refused = setup({ org: { attachmentRead: vi.fn(async () => refusal("attachment_deleted", 410)) } });
    expect((await refused.call("GET", `/sessions/${SID}/attachments/${AT}/url`)).status).toBe(410);
    const none = setup({ org: { attachmentRead: vi.fn(async () => ({ ok: true, attachment: attachment() })) }, s3: false });
    expect((await none.call("GET", `/sessions/${SID}/attachments/${AT}/url`)).status).toBe(503);
  });
});

describe("DELETE /sessions/{sid}/attachments/{id}", () => {
  it("answers 204 on Org's ok, and its refusals", async () => {
    const org = { attachmentDelete: vi.fn(async () => ({ ok: true })) };
    const { call } = setup({ org });
    expect((await call("DELETE", `/sessions/${SID}/attachments/${AT}`)).status).toBe(204);
    expect(org.attachmentDelete).toHaveBeenCalledWith(memberP, SID, AT);
    org.attachmentDelete.mockResolvedValue(refusal("attachment_in_use", 409) as never);
    const r = await call("DELETE", `/sessions/${SID}/attachments/${AT}`);
    expect([r.status, r.body.error.code]).toEqual([409, "attachment_in_use"]);
    expect((await call("DELETE", `/sessions/${SID}/attachments/${AT}`, { identity: key(["sessions:read"]) })).status).toBe(403);
  });
});

describe("a turn's attachments (sections 4, 6): named in Org before the accept, nothing to undo when it refuses", () => {
  const metas = [{ id: AT, name: "notes.txt", mimetype: "text/plain", bytes: 5 }, { id: AT2, name: "shot.png", mimetype: "image/png", bytes: 9 }];
  const org = () => ({
    attachmentReserve: vi.fn(async () => ({ ok: true, attachments: metas })),
    createSession: vi.fn(async (_p: Principal, body: { id?: string }) => ({ ok: true, session: row(body.id), place: null, duplicate: false })),
  });

  it("POST /sessions/{sid}/turns: the ids reserved for the turn, their metadata in the entry; input may be empty", async () => {
    const o = org();
    const log = { accept: vi.fn(async (_p: Principal, entry: { id: string; body: unknown }) => ({ ok: true, id: entry.id, duplicate: false, outcome: { state: "delivered", result: { turn: { id: entry.id }, delivery: "started", seq: 4 } } })) };
    const { call } = setup({ org: o, log });
    const r = await call("POST", `/sessions/${SID}/turns`, { body: { id: "tn_000000000001", input: "", attachments: [AT, AT2] } });
    expect(r.status).toBe(200);
    expect(o.attachmentReserve).toHaveBeenCalledWith(memberP, SID, "tn_000000000001", null, [AT, AT2]);
    expect(log.accept.mock.calls[0]![1]).toMatchObject({ id: "tn_000000000001", kind: "turn", body: { input: "", attachments: metas } });
    expect(log.accept.mock.calls[0]![1].body).not.toHaveProperty("attachments.0.state");
  });

  it("a steer's attachments are the message's own: the entry's id is the messageId of the reserve", async () => {
    const o = org();
    const log = { accept: vi.fn(async (_p: Principal, entry: { id: string }) => ({ ok: true, id: entry.id, duplicate: false, outcome: { state: "delivered", result: { turn: { id: entry.id }, delivery: "steered", seq: 5 } } })) };
    const { call } = setup({ org: o, log });
    const r = await call("POST", `/sessions/${SID}/turns`, { body: { id: "tn_000000000002", input: "also this", ifBusy: "steer", attachments: [AT] } });
    expect(r.status).toBe(200);
    expect(o.attachmentReserve).toHaveBeenCalledWith(memberP, SID, "tn_000000000002", "tn_000000000002", [AT]);
  });

  it("refuses the turn with Org's reserve refusal before the accept; an accept that refuses leaves them to be sent again", async () => {
    const o = org();
    o.attachmentReserve.mockResolvedValueOnce(refusal("attachment_not_ready", 409, { attachmentId: AT }) as never);
    const log = { accept: vi.fn(async () => refusal("forbidden", 403)) };
    const { call } = setup({ org: o, log });
    const r = await call("POST", `/sessions/${SID}/turns`, { body: { input: "x", attachments: [AT] } });
    expect([r.status, r.body.error.code, r.body.error.attachmentId]).toEqual([409, "attachment_not_ready", AT]);
    expect(log.accept).not.toHaveBeenCalled();
    // The log's forbidden is the session not seen (session-entry.ts): 404. The same ids go with the next try.
    const refused = await call("POST", `/sessions/${SID}/turns`, { body: { id: "tn_000000000002", input: "x", attachments: [AT] } });
    expect([refused.status, refused.body.error.code]).toEqual([404, "session_not_found"]);
    expect(o.attachmentReserve).toHaveBeenLastCalledWith(memberP, SID, "tn_000000000002", null, [AT]);
  });

  it("checks the list's shape before anything is asked: ids, at most ten, no repeats; a turn without them has no input of length zero", async () => {
    const o = org();
    const { call } = setup({ org: o, log: { accept: vi.fn() } });
    for (const body of [
      { input: "x", attachments: ["nope"] },
      { input: "x", attachments: Array.from({ length: 11 }, (_, i) => `at_${String(i).padStart(16, "0")}`) },
      { input: "x", attachments: [AT, AT] },
      { input: "", attachments: [] },
      { input: "" },
    ]) {
      const r = await call("POST", `/sessions/${SID}/turns`, { body });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
    }
    expect(o.attachmentReserve).not.toHaveBeenCalled();
  });

  it("POST /sessions with attachments: the id made here, the first turn's ids reserved before the create, the metadata in the create and the first turn's entry", async () => {
    const o = org();
    const log = { accept: vi.fn(async (_p: Principal, entry: { id: string }) => ({ ok: true, id: entry.id, duplicate: false, outcome: { state: "delivered", result: { turn: { id: entry.id }, delivery: "started", seq: 1 } } })) };
    const { call } = setup({ org: o, log });
    const r = await call("POST", "/sessions", { body: { input: "", attachments: [AT, AT2] } });
    expect(r.status).toBe(201);
    const id = r.body.session.id as string;
    expect(id).toMatch(/^cs_[0-9a-hjkmnp-tv-z]{16}$/);
    expect(o.attachmentReserve).toHaveBeenCalledWith(memberP, id, firstTurnId(id), null, [AT, AT2]);
    expect(o.createSession).toHaveBeenCalledWith(memberP, expect.objectContaining({ id, input: "", attachments: metas }));
    expect(log.accept.mock.calls[0]![1]).toMatchObject({ id: firstTurnId(id), kind: "turn", body: { input: "", ifBusy: "queue", attachments: metas } });
    // Reserve before create: a refusal there is the answer, the create never asked.
    o.attachmentReserve.mockResolvedValueOnce(refusal("attachment_not_found", 404, { attachmentId: AT }) as never);
    expect((await call("POST", "/sessions", { body: { id: OTHER, input: "x", attachments: [AT] } })).status).toBe(404);
    expect(o.createSession).toHaveBeenCalledTimes(1);
  });

  it("POST /sessions answers the create's refusal; the attachments stay for the next try", async () => {
    const o = org();
    o.createSession.mockResolvedValueOnce(refusal("taken", 409) as never);
    const { call } = setup({ org: o, log: { accept: vi.fn() } });
    const r = await call("POST", "/sessions", { body: { id: OTHER, turnId: "tn_000000000009", input: "x", attachments: [AT] } });
    expect(r.status).toBe(409);
    expect(o.attachmentReserve).toHaveBeenCalledWith(memberP, OTHER, "tn_000000000009", null, [AT]);
  });
});
