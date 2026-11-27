// The attachment routes (work 126, section 4) through the API's dispatch: the row from the headers
// before the body is read, the body streamed into the store and out of it with Range and the
// content headers, and a turn's `attachments` reserved before the accept and released when it
// refuses. Org and the store are fakes.

import { describe, expect, it, vi } from "vitest";

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

/** An R2 bucket in memory: what `r2Attachments` asks of one. */
function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const b = {
    objects,
    put: vi.fn(async (key: string, body: ReadableStream, opts: { httpMetadata: { contentType: string } }) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, contentType: opts.httpMetadata.contentType });
      return { httpEtag: `"etag-${bytes.length}"` };
    }),
    get: vi.fn(async (key: string, opts?: { range?: { offset: number; length: number } }) => {
      const o = objects.get(key);
      if (!o) return null;
      const r = opts?.range;
      const slice = r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes;
      return { body: new Response(slice).body!, size: o.bytes.length, httpEtag: `"etag-${o.bytes.length}"` };
    }),
    delete: vi.fn(async (keys: string | string[]) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => objects.delete(k))),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false })),
  };
  return b;
}

interface Fakes {
  org?: Record<string, unknown>;
  log?: Record<string, unknown>;
  computer?: Record<string, unknown>;
  bucket?: ReturnType<typeof bucket> | null;
}

function setup(f: Fakes) {
  const env = {
    ORGS: ns(() => f.org ?? {}),
    SESSION_LOG: ns(() => f.log ?? {}),
    COMPUTERS: ns(() => f.computer ?? {}),
    ...(f.bucket === null ? {} : { ATTACHMENTS: f.bucket ?? bucket() }),
  };
  const stub: ComputerApiStub = { computerApi: vi.fn() };
  const call = async (method: string, path: string, opts: { body?: unknown; raw?: BodyInit; headers?: Record<string, string>; identity?: RequestIdentity } = {}) => {
    const url = new URL(`https://blue.test/v1/computer${path}`);
    const res = await routeComputerApi(
      new Request(url, {
        method,
        headers: { ...(opts.raw === undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : opts.raw !== undefined ? { body: opts.raw } : {}),
      }),
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

/** The upload's headers: a 5-byte text file named notes.txt. */
const upload = (over: Record<string, string> = {}) => ({ "content-type": "text/plain", "content-length": "5", "content-disposition": "attachment; filename=\"notes.txt\"", ...over });

describe("PUT /sessions/{sid}/attachments/{id}/content (section 4)", () => {
  const org = () => ({
    attachmentCreate: vi.fn(async () => ({ ok: true, created: true, attachment: attachment({ state: "uploading", etag: null }) })),
    attachmentReady: vi.fn(async (_id: string, etag: string) => ({ ok: true, attachment: attachment({ etag }) })),
  });

  it("creates the row from the headers, streams the body into the store under the org/session/id key, and marks it ready: 201", async () => {
    const o = org();
    const b = bucket();
    const { call } = setup({ org: o, bucket: b });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello", headers: upload() });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ attachment: attachment({ etag: '"etag-5"' }) });
    expect(o.attachmentCreate).toHaveBeenCalledWith(memberP, SID, AT, { name: "notes.txt", mimetype: "text/plain", bytes: 5 });
    expect(o.attachmentReady).toHaveBeenCalledWith(AT, '"etag-5"');
    expect(b.put).toHaveBeenCalledWith(`${ORG}/${SID}/${AT}`, expect.anything(), { httpMetadata: { contentType: "text/plain" } });
    expect(new TextDecoder().decode(b.objects.get(`${ORG}/${SID}/${AT}`)!.bytes)).toBe("hello");
  });

  it("takes the name from filename*=UTF-8'' first and the media type without its parameters; a key with sessions:write may, a read key may not", async () => {
    const o = org();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, {
      raw: "hello",
      headers: upload({ "content-type": "Text/Plain; charset=utf-8", "content-disposition": "attachment; filename=\"fallback.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%2B.txt" }),
      identity: key(["sessions:write"]),
    });
    expect(r.status).toBe(201);
    expect(o.attachmentCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: "key" }), SID, AT, { name: "résumé +.txt", mimetype: "text/plain", bytes: 5 });
    expect((await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello", headers: upload(), identity: key(["sessions:read"]) })).status).toBe(403);
  });

  it.each([
    ["no content-type", upload({ "content-type": "" }), "content-type"],
    ["a content-type that is not a media type", upload({ "content-type": "plain" }), "content-type"],
    ["no content-length", upload({ "content-length": "" }), "content-length"],
    ["no content-disposition", upload({ "content-disposition": "" }), "content-disposition"],
    ["a filename with a path", upload({ "content-disposition": "attachment; filename=\"../x.txt\"" }), "content-disposition"],
    ["a filename of control characters", upload({ "content-disposition": "attachment; filename*=UTF-8''a%00b" }), "content-disposition"],
  ])("refuses %s before Org is asked: 400 invalid_request", async (_what, headers, field) => {
    const o = org();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello", headers });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: "invalid_request", field } });
    expect(o.attachmentCreate).not.toHaveBeenCalled();
  });

  it("refuses a content-length past the limit before the row and the body: 413 attachment_too_large", async () => {
    const o = org();
    const b = bucket();
    const { call } = setup({ org: o, bucket: b });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello", headers: upload({ "content-length": String(ATTACHMENT_BYTES_MAX + 1) }) });
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ error: { code: "attachment_too_large", max: ATTACHMENT_BYTES_MAX } });
    expect(o.attachmentCreate).not.toHaveBeenCalled();
    expect(b.put).not.toHaveBeenCalled();
  });

  it("answers Org's refusal with its status, the body unread", async () => {
    const b = bucket();
    for (const [code, status] of [["session_not_found", 404], ["forbidden", 403], ["attachment_quota", 429], ["content_mismatch", 400], ["attachment_in_use", 409], ["attachment_deleted", 410]] as const) {
      const o = { ...org(), attachmentCreate: vi.fn(async () => refusal(code, status)) };
      const { call } = setup({ org: o, bucket: b });
      const r = await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello", headers: upload() });
      expect([r.status, r.body.error.code]).toEqual([status, code]);
    }
    expect(b.put).not.toHaveBeenCalled();
  });

  it("replays a row already ready from the same headers: 200 without reading the body", async () => {
    const o = { ...org(), attachmentCreate: vi.fn(async () => ({ ok: true, created: false, attachment: attachment() })) };
    const b = bucket();
    const { call } = setup({ org: o, bucket: b });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello", headers: upload() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ attachment: attachment() });
    expect(b.put).not.toHaveBeenCalled();
    expect(o.attachmentReady).not.toHaveBeenCalled();
  });

  it("refuses a body of another length than content-length: 400 content_mismatch, nothing marked ready", async () => {
    const o = org();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello world", headers: upload() });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: "content_mismatch" } });
    expect(o.attachmentReady).not.toHaveBeenCalled();
  });

  it("answers 503 unavailable without a store, and when the store fails", async () => {
    const o = org();
    const { call } = setup({ org: o, bucket: null });
    const none = await call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello", headers: upload() });
    expect(none.status).toBe(503);
    expect(none.body).toMatchObject({ error: { code: "unavailable", retryAfterMs: 5000 } });
    const broken = bucket();
    broken.put.mockRejectedValue(new Error("r2 down"));
    const failed = await setup({ org: o, bucket: broken }).call("PUT", `/sessions/${SID}/attachments/${AT}/content`, { raw: "hello", headers: upload() });
    expect(failed.status).toBe(503);
    expect(o.attachmentReady).not.toHaveBeenCalled();
  });

  it("names no attachment for an id of another shape, and no route for POST", async () => {
    const o = org();
    const { call } = setup({ org: o });
    const r = await call("PUT", `/sessions/${SID}/attachments/at_nope/content`, { raw: "hello", headers: upload() });
    expect([r.status, r.body.error.code]).toEqual([404, "attachment_not_found"]);
    expect((await call("POST", `/sessions/${SID}/attachments`, { body: {} })).status).toBe(404);
    expect(o.attachmentCreate).not.toHaveBeenCalled();
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

describe("GET /sessions/{sid}/attachments/{id}/content", () => {
  const stored = (over: Record<string, unknown> = {}) => {
    const b = bucket();
    b.objects.set(`${ORG}/${SID}/${AT}`, { bytes: new TextEncoder().encode("hello"), contentType: "text/plain" });
    const org = { attachmentRead: vi.fn(async () => ({ ok: true, attachment: attachment({ etag: '"etag-5"', ...over }) })) };
    return { ...setup({ org, bucket: b }), org, b };
  };

  it("streams the object with the row's type, nosniff, no-store, an attachment disposition and the etag", async () => {
    const { call, b } = stored();
    const r = await call("GET", `/sessions/${SID}/attachments/${AT}/content`);
    expect(r.status).toBe(200);
    expect(r.text).toBe("hello");
    expect(r.headers).toMatchObject({
      "content-type": "text/plain",
      "content-length": "5",
      "content-disposition": "attachment; filename*=UTF-8''notes.txt",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "accept-ranges": "bytes",
      etag: '"etag-5"',
    });
    expect(b.get).toHaveBeenCalledWith(`${ORG}/${SID}/${AT}`, undefined);
  });

  it("serves raster images inline, everything else as an attachment, the name percent-encoded", async () => {
    for (const [mimetype, name, disposition] of [
      ["image/png", "shot.png", "inline; filename*=UTF-8''shot.png"],
      ["image/svg+xml", "logo.svg", "attachment; filename*=UTF-8''logo.svg"],
      ["text/html", "a b's.html", "attachment; filename*=UTF-8''a%20b%27s.html"],
      ["application/pdf", "doc.pdf", "attachment; filename*=UTF-8''doc.pdf"],
    ]) {
      const { call } = stored({ mimetype, name });
      const r = await call("GET", `/sessions/${SID}/attachments/${AT}/content`);
      expect([r.status, r.headers["content-type"], r.headers["content-disposition"]]).toEqual([200, mimetype, disposition]);
    }
  });

  it("serves one Range as 206 with content-range, 416 past the end, and the whole for a Range it does not understand", async () => {
    const { call, b } = stored();
    const part = await call("GET", `/sessions/${SID}/attachments/${AT}/content`, { headers: { range: "bytes=1-3" } });
    expect([part.status, part.text, part.headers["content-range"], part.headers["content-length"]]).toEqual([206, "ell", "bytes 1-3/5", "3"]);
    expect(b.get).toHaveBeenLastCalledWith(`${ORG}/${SID}/${AT}`, { range: { offset: 1, length: 3 } });
    const tail = await call("GET", `/sessions/${SID}/attachments/${AT}/content`, { headers: { range: "bytes=-2" } });
    expect([tail.status, tail.text, tail.headers["content-range"]]).toEqual([206, "lo", "bytes 3-4/5"]);
    const open = await call("GET", `/sessions/${SID}/attachments/${AT}/content`, { headers: { range: "bytes=4-" } });
    expect([open.status, open.text, open.headers["content-range"]]).toEqual([206, "o", "bytes 4-4/5"]);
    const past = await call("GET", `/sessions/${SID}/attachments/${AT}/content`, { headers: { range: "bytes=5-" } });
    expect([past.status, past.headers["content-range"], past.text]).toEqual([416, "bytes */5", ""]);
    const odd = await call("GET", `/sessions/${SID}/attachments/${AT}/content`, { headers: { range: "bytes=0-1,3-4" } });
    expect([odd.status, odd.text]).toEqual([200, "hello"]);
  });

  it("answers 304 to a matching if-none-match without reading the store", async () => {
    const { call, b } = stored();
    const r = await call("GET", `/sessions/${SID}/attachments/${AT}/content`, { headers: { "if-none-match": '"other", "etag-5"' } });
    expect([r.status, r.text, r.headers.etag]).toEqual([304, "", '"etag-5"']);
    expect(b.get).not.toHaveBeenCalled();
  });

  it("refuses one still uploading (409), one whose object is gone (404), and what Org refuses", async () => {
    const { call: uploading } = stored({ state: "uploading", etag: null });
    const u = await uploading("GET", `/sessions/${SID}/attachments/${AT}/content`);
    expect([u.status, u.body.error.code]).toEqual([409, "attachment_not_ready"]);
    const { call, b } = stored();
    b.objects.clear();
    const gone = await call("GET", `/sessions/${SID}/attachments/${AT}/content`);
    expect([gone.status, gone.body.error.code]).toEqual([404, "attachment_not_found"]);
    const refused = setup({ org: { attachmentRead: vi.fn(async () => refusal("attachment_not_found", 404)) } });
    expect((await refused.call("GET", `/sessions/${SID}/attachments/${AT}/content`, { identity: agent })).status).toBe(404);
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

describe("a turn's attachments (sections 4, 6): reserved before the accept, released when it refuses", () => {
  const metas = [{ id: AT, name: "notes.txt", mimetype: "text/plain", bytes: 5 }, { id: AT2, name: "shot.png", mimetype: "image/png", bytes: 9 }];
  const org = () => ({
    attachmentReserve: vi.fn(async () => ({ ok: true, attachments: metas })),
    attachmentRelease: vi.fn(async () => undefined),
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
    expect(o.attachmentRelease).not.toHaveBeenCalled();
  });

  it("refuses the turn with Org's reserve refusal before the accept; releases when the accept refuses", async () => {
    const o = org();
    o.attachmentReserve.mockResolvedValueOnce(refusal("attachment_not_ready", 409, { attachmentId: AT }) as never);
    const log = { accept: vi.fn(async () => refusal("forbidden", 403)) };
    const { call } = setup({ org: o, log });
    const r = await call("POST", `/sessions/${SID}/turns`, { body: { input: "x", attachments: [AT] } });
    expect([r.status, r.body.error.code, r.body.error.attachmentId]).toEqual([409, "attachment_not_ready", AT]);
    expect(log.accept).not.toHaveBeenCalled();
    // The log's forbidden is the session not seen (session-entry.ts): 404, and the turn's rows go back to ready.
    const refused = await call("POST", `/sessions/${SID}/turns`, { body: { id: "tn_000000000002", input: "x", attachments: [AT] } });
    expect([refused.status, refused.body.error.code]).toEqual([404, "session_not_found"]);
    expect(o.attachmentRelease).toHaveBeenCalledWith(SID, "tn_000000000002", [AT]);
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
    expect(o.attachmentRelease).not.toHaveBeenCalled();
    // Reserve before create: a refusal there is the answer, the create never asked.
    o.attachmentReserve.mockResolvedValueOnce(refusal("attachment_not_found", 404, { attachmentId: AT }) as never);
    expect((await call("POST", "/sessions", { body: { id: OTHER, input: "x", attachments: [AT] } })).status).toBe(404);
    expect(o.createSession).toHaveBeenCalledTimes(1);
  });

  it("POST /sessions releases the first turn's attachments when the create refuses", async () => {
    const o = org();
    o.createSession.mockResolvedValueOnce(refusal("taken", 409) as never);
    const { call } = setup({ org: o, log: { accept: vi.fn() } });
    const r = await call("POST", "/sessions", { body: { id: OTHER, turnId: "tn_000000000009", input: "x", attachments: [AT] } });
    expect(r.status).toBe(409);
    expect(o.attachmentRelease).toHaveBeenCalledWith(OTHER, "tn_000000000009", [AT]);
  });
});
