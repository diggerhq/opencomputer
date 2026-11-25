// Tracks and threads at the edge (spec 34.3, 37, 38, 18.7): the principal in
// the assertion, the allowlist, principal_mismatch, the /live upgrade, Live's
// credential check and the Mac app's sign-in, against the real D1 schema.
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "./index";
import { hashAPIKey } from "./api_keys";
import { isComputerApiRoute } from "./computer_api";
import { memberId } from "./principal";
import { d1Of, schemaDB, type DatabaseSync } from "./test_sqlite_d1";

const ORIGIN = "https://app.opencomputer.dev";
const BLUE = "https://managedagents.test";
const ORG = "org_tt";
const USER = "user_01J0000000000000000000000A";
const SUBJECT = "usr_01j0000000000000000000000a";
const SESSION = "cs_0123456789abcdef";

function seeded(): { db: DatabaseSync; env: Env } {
  const db = schemaDB();
  const now = 1_790_000_000;
  db.prepare(
    "INSERT INTO orgs (id, name, slug, plan, home_cell, created_at, updated_at) VALUES (?, 'Acme', 'acme', 'pro', 'c', ?, ?)",
  ).run(ORG, now, now);
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, 'igor@example.com', 'Igor', ?)").run(USER, now);
  db.prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(ORG, USER, now);
  const env = {
    OPENCOMPUTER_DB: d1Of(db),
    SESSION_JWT_SECRET: "test-session-secret",
    WORKER_ENV: "test",
    CF_ADMIN_SECRET: "",
    MANAGED_AGENTS_API_URL: BLUE,
    OC_MANAGED_AGENTS_SECRET: "assert-secret",
    COMPUTER_ENABLED_FOR_ALL: "true",
  } as unknown as Env;
  return { db, env };
}

let keySeq = 0;
async function addKey(
  db: DatabaseSync,
  o: { createdBy?: string; scopes?: string; sessionKey?: string | null; expiresAt?: number | null } = {},
): Promise<{ key: string; id: string }> {
  keySeq += 1;
  const key = `osb_tt_${keySeq}_${crypto.randomUUID().replace(/-/g, "")}`;
  const id = `key-tt-${keySeq}-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO api_keys (id, org_id, created_by, key_hash, key_prefix, name, scopes, created_at, expires_at, session_key)
     VALUES (?, ?, ?, ?, 'osb_tt', 'laptop', ?, 1790000000, ?, ?)`,
  ).run(id, ORG, o.createdBy ?? USER, await hashAPIKey(key), o.scopes ?? "sessions:read,sessions:write,asks:answer,terminals", o.expiresAt ?? null, o.sessionKey ?? null);
  return { key, id };
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sessionCookie(): Promise<string> {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const input =
    b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))) +
    "." +
    b64url(enc.encode(JSON.stringify({ iss: "opensandbox-session", sub: USER, iat: now, exp: now + 3600, org_id: ORG, user_id: USER, plan: "pro" })));
  const key = await crypto.subtle.importKey("raw", enc.encode("test-session-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `oc_session=${input}.${b64url(await crypto.subtle.sign("HMAC", key, enc.encode(input)))}`;
}

function claims(token: string): Record<string, unknown> {
  return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

function ctx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function api(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}/api/managed-agents/computer${path}`, init);
}

function assertedPrincipal(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return claims(new Headers(init.headers).get("x-opencomputer-agent-token") ?? "").oc_principal as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the principal in the assertion", () => {
  it("maps a member id as managed agents does", async () => {
    expect(await memberId(USER)).toBe(SUBJECT);
    expect(await memberId("11111111-1111-4111-8111-111111111111")).toMatch(/^usr_x[0-9a-f]{26}$/);
  });

  it("names a cookie member with the surface's scopes", async () => {
    const { env } = seeded();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ protocol: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(api("/feed", { headers: { cookie: await sessionCookie() } }), env, ctx());
    expect(res.status).toBe(200);
    const p = assertedPrincipal(fetchMock);
    expect(p).toMatchObject({
      org: ORG,
      subject: SUBJECT,
      kind: "member",
      via: "dashboard",
      scopes: ["sessions:read", "sessions:write", "asks:answer", "work:read", "work:write"],
      audiences: ["org", `member:${SUBJECT}`],
      admin: true,
    });
    const credential = p.credential as { id: string; expiresAt: number };
    expect(credential.id).toMatch(new RegExp(`^ck:${ORG}:${USER}:\\d+:[0-9a-f]{16}$`));
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
    expect(p.session).toBeUndefined();
  });

  it("names a key by its creator, opc or api by the user agent, keeping the old claims", async () => {
    const { db, env } = seeded();
    const { key, id } = await addKey(db, { expiresAt: 1_900_000_000 });
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await worker.fetch(api("/sessions", { headers: { "x-api-key": key, "user-agent": "opc/1.0" } }), env, ctx());
    await worker.fetch(api("/sessions", { headers: { "x-api-key": key } }), env, ctx());
    expect(assertedPrincipal(fetchMock, 0)).toEqual({
      org: ORG,
      subject: SUBJECT,
      kind: "key",
      via: "opc",
      scopes: ["sessions:read", "sessions:write", "asks:answer", "terminals"],
      audiences: ["org", `member:${SUBJECT}`],
      admin: true,
      credential: { id, expiresAt: 1_900_000_000_000 },
    });
    expect(assertedPrincipal(fetchMock, 1).via).toBe("api");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(claims(new Headers(init.headers).get("x-opencomputer-agent-token")!)).toMatchObject({ key_id: id, user_id: USER, role: "admin" });
  });

  it("makes a session's key that session's agent: work scopes, no terminals", async () => {
    const { db, env } = seeded();
    const { key, id } = await addKey(db, { createdBy: "computer", scopes: "sessions:read,sessions:write,asks:answer,terminals", sessionKey: SESSION, expiresAt: 1_900_000_000 });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(api("/work/overview", { headers: { authorization: `Bearer ${key}` } }), env, ctx());
    expect(res.status).toBe(200);
    expect(assertedPrincipal(fetchMock)).toEqual({
      org: ORG,
      subject: SESSION,
      kind: "agent",
      via: "agent",
      scopes: ["sessions:read", "sessions:write", "asks:answer", "work:read", "work:write"],
      audiences: [],
      session: SESSION,
      admin: false,
      credential: { id, expiresAt: 1_900_000_000_000 },
    });
  });
});

describe("the allowlist of tracks and threads", () => {
  it.each([
    ["GET", "/feed"],
    ["POST", "/feed/mismatch"],
    ["GET", "/occurrences"],
    ["GET", "/live"],
    ["GET", "/work/threads"],
    ["GET", "/work/overview"],
    ["GET", "/work/tracks/trk_0123456789abcdef/doc/revisions"],
    ["GET", "/work/tracks/trk_0123456789abcdef/doc/revisions/3"],
    ["GET", "/work/results/res_0123456789abcdef/review"],
    ["GET", "/work/results/res_0123456789abcdef/diff"],
    ["GET", "/work/search"],
    ["GET", "/webhooks"],
    ["PUT", "/webhooks/wh_1"],
    ["DELETE", "/webhooks/wh_1"],
    ["POST", "/work/tell-track"],
    ["POST", "/slack/threads/T1:C1:1792176058.240229/messages"],
    ["PUT", `/work/threads/${SESSION}/title`],
    ["PUT", `/work/threads/${SESSION}/track`],
    ["PUT", `/work/threads/${SESSION}/done`],
    ["DELETE", `/work/threads/${SESSION}/done`],
    ["PUT", `/work/threads/${SESSION}/keep`],
    ["PUT", `/work/threads/${SESSION}/ready`],
    ["PUT", `/work/threads/${SESSION}/attention`],
    ["PUT", `/work/threads/${SESSION}/writers`],
    ["DELETE", `/work/threads/${SESSION}`],
    ["POST", "/work/tracks"],
    ["PUT", "/work/tracks/trk_1/name"],
    ["PUT", "/work/tracks/trk_1/stand"],
    ["PUT", "/work/tracks/trk_1/done"],
    ["DELETE", "/work/tracks/trk_1/done"],
    ["PUT", "/work/tracks/trk_1/keep"],
    ["POST", "/work/tracks/trk_1/dissolve"],
    ["DELETE", "/work/tracks/trk_1"],
    ["PUT", `/work/reads/${SESSION}`],
    ["PUT", "/work/prefs/layout"],
    ["PUT", "/work/tracks/trk_1/doc"],
    ["PUT", "/work/results/res_1"],
    ["PUT", "/work/results/res_1/review"],
    ["POST", "/work/proposals"],
    ["POST", "/work/proposals/prp_1/accept"],
    ["POST", "/work/proposals/prp_1/dismiss"],
    ["POST", "/work/ops/op_1/undo"],
  ])("allows %s %s", (method, path) => {
    expect(isComputerApiRoute(method, `/computer${path}`)).toBe(true);
  });

  it.each([
    ["GET", "/work/tracks"],
    ["POST", "/work/threads/cs_1/title"],
    ["PUT", "/work/threads/cs_1/rename"],
    ["GET", "/feed/mismatch"],
    ["POST", "/work/ops/op_1/redo"],
    ["GET", "/work/tracks/trk_1/doc/revisions/1/2"],
  ])("refuses %s %s", (method, path) => {
    expect(isComputerApiRoute(method, `/computer${path}`)).toBe(false);
  });

  it("forwards trace, principal, client, n and Idempotency-Key", async () => {
    const { db, env } = seeded();
    const { key } = await addKey(db, { scopes: "sessions:read,work:read,work:write" });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ protocol: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      api(`/work/threads/${SESSION}/title`, {
        method: "PUT",
        headers: {
          "x-api-key": key,
          "content-type": "application/json",
          "x-oc-trace": "tr_0123456789abcdef",
          "x-oc-principal": `${ORG}/${SUBJECT}`,
          "x-oc-client": "cl_0123456789abcdef",
          "x-oc-n": "7",
          "idempotency-key": "idem-7",
        },
        body: JSON.stringify({ title: "x" }),
      }),
      env,
      ctx(),
    );
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe(`${BLUE}/v1/computer/work/threads/${SESSION}/title`);
    const headers = new Headers(init.headers);
    expect(headers.get("x-oc-trace")).toBe("tr_0123456789abcdef");
    expect(headers.get("x-oc-principal")).toBe(`${ORG}/${SUBJECT}`);
    expect(headers.get("x-oc-client")).toBe("cl_0123456789abcdef");
    expect(headers.get("x-oc-n")).toBe("7");
    expect(headers.get("idempotency-key")).toBe("idem-7");
  });

  it("answers an unknown route 404 without calling managed agents", async () => {
    const { env } = seeded();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(api("/work/nothing", { headers: { cookie: await sessionCookie() } }), env, ctx());
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers x-oc-principal naming another principal 403 principal_mismatch", async () => {
    const { db, env } = seeded();
    const { key } = await addKey(db);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cases: Record<string, string>[] = [
      { "x-api-key": key, "x-oc-principal": `${ORG}/usr_someoneelse` },
      { cookie: await sessionCookie(), "x-oc-principal": `org_other/${SUBJECT}` },
    ];
    for (const headers of cases) {
      const res = await worker.fetch(api("/feed", { headers }), env, ctx());
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("principal_mismatch");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a new route to a credential without its scope", async () => {
    const { db, env } = seeded();
    const { key } = await addKey(db, { scopes: "sessions:read" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(api("/work/overview", { headers: { "x-api-key": key } }), env, ctx());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe("missing_scope");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
