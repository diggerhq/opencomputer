// Tracks and threads at the edge (spec 34.3, 37, 38, 18.7): the principal in
// the assertion, the allowlist, principal_mismatch, the /live upgrade, Live's
// credential check and the Mac app's sign-in, against the real D1 schema.
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env, LiveCredentials } from "./index";
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
      scopes: ["sessions:read", "sessions:write", "asks:answer", "secrets:write", "terminals", "work:read", "work:write"],
      audiences: ["org", `member:${SUBJECT}`],
      admin: true,
    });
    const credential = p.credential as { id: string; expiresAt: number };
    expect(credential.id).toMatch(new RegExp(`^ck:${ORG}:${USER}:\\d+:[0-9a-f]{16}$`));
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
    expect(p.session).toBeUndefined();
  });

  it("names a key by its creator, opc or api by the user agent; the principal is the only caller claim", async () => {
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
    expect(claims(new Headers(init.headers).get("x-opencomputer-agent-token")!)).toMatchObject({ key_id: id, user_id: USER });
    expect(claims(new Headers(init.headers).get("x-opencomputer-agent-token")!).role).toBeUndefined();
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
    ["GET", "/work/tracks/trk_0123456789abcdef/doc"],
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
    ["GET", "/work/tracks/trk_1/doc/other"],
  ])("refuses %s %s", (method, path) => {
    expect(isComputerApiRoute(method, `/computer${path}`)).toBe(false);
  });

  it("forwards trace, principal and Idempotency-Key, and no longer x-oc-client or x-oc-n", async () => {
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
    expect(headers.get("x-oc-client")).toBeNull();
    expect(headers.get("x-oc-n")).toBeNull();
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

function settlingCtx(): { ctx: ExecutionContext; settle: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, settle: async () => void (await Promise.allSettled(pending)) };
}

/** What Live answers an upgrade (Node's Response cannot carry a 101). */
function upgraded(): Response {
  return { status: 101, ok: false, headers: new Headers({ "sec-websocket-protocol": "oc.live.v1" }), webSocket: {} } as unknown as Response;
}

function liveRequest(headers: Record<string, string>): Request {
  return api("/live", { headers: { upgrade: "websocket", ...headers } });
}

describe("GET /live", () => {
  it("passes a cookie's upgrade from the exact Origin, with only oc.live.v1", async () => {
    const { env } = seeded();
    const fetchMock = vi.fn().mockResolvedValue(upgraded());
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      liveRequest({ cookie: await sessionCookie(), origin: ORIGIN, "sec-websocket-protocol": "oc.live.v1" }),
      env,
      ctx(),
    );
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("oc.live.v1");
    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe(`${BLUE}/v1/computer/live`);
    const headers = new Headers(init.headers);
    expect(headers.get("upgrade")).toBe("websocket");
    expect(headers.get("sec-websocket-protocol")).toBe("oc.live.v1");
    expect(assertedPrincipal(fetchMock)).toMatchObject({ subject: SUBJECT, kind: "member", via: "dashboard" });
  });

  it("refuses a cookie without the exact Origin", async () => {
    const { env } = seeded();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const origin of [null, "https://evil.example", `${ORIGIN}.evil.example`]) {
      const headers: Record<string, string> = { cookie: await sessionCookie(), "sec-websocket-protocol": "oc.live.v1" };
      if (origin) headers.origin = origin;
      expect((await worker.fetch(liveRequest(headers), env, ctx())).status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authenticates a key or a session's key offered as oc.bearer, and never forwards it", async () => {
    const { db, env } = seeded();
    const person = await addKey(db);
    const agent = await addKey(db, { createdBy: "computer", sessionKey: SESSION });
    const fetchMock = vi.fn().mockImplementation(async () => upgraded());
    vi.stubGlobal("fetch", fetchMock);
    for (const { key } of [person, agent]) {
      const res = await worker.fetch(liveRequest({ "sec-websocket-protocol": `oc.live.v1, oc.bearer.${key}` }), env, ctx());
      expect(res.status).toBe(101);
    }
    expect(assertedPrincipal(fetchMock, 0)).toMatchObject({ kind: "key", subject: SUBJECT, credential: { id: person.id } });
    expect(assertedPrincipal(fetchMock, 1)).toMatchObject({ kind: "agent", subject: SESSION, credential: { id: agent.id } });
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(new Headers(init.headers).get("sec-websocket-protocol")).toBe("oc.live.v1");
    }
  });

  it("refuses a bad token, a missing upgrade and a missing oc.live.v1", async () => {
    const { db, env } = seeded();
    const { key } = await addKey(db);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await worker.fetch(liveRequest({ "sec-websocket-protocol": "oc.live.v1, oc.bearer.osb_nope" }), env, ctx())).status).toBe(401);
    expect((await worker.fetch(api("/live", { headers: { "sec-websocket-protocol": `oc.live.v1, oc.bearer.${key}` } }), env, ctx())).status).toBe(426);
    expect((await worker.fetch(liveRequest({ "sec-websocket-protocol": `oc.bearer.${key}` }), env, ctx())).status).toBe(426);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Live's credential check", () => {
  const credentials = (env: Env) => new LiveCredentials(ctx(), env);
  const check = async (env: Env, body: { check?: string[]; token?: string }) =>
    body.token !== undefined ? { principal: await credentials(env).principal(body.token) } : { revoked: await credentials(env).revoked(body.check!) };

  it("takes at most 500 ids", async () => {
    const { env } = seeded();
    await expect(credentials(env).revoked(Array.from({ length: 501 }, (_, i) => `key_${i}`))).rejects.toThrow();
  });

  it("answers a token's principal, null when it does not verify", async () => {
    const { db, env } = seeded();
    const { key, id } = await addKey(db, { createdBy: "computer", sessionKey: SESSION });
    expect(await check(env, { token: key })).toMatchObject({ principal: { org: ORG, subject: SESSION, kind: "agent", credential: { id } } });
    expect(await check(env, { token: "osb_nope" })).toEqual({ principal: null });
  });

  it("names the credentials that no longer verify", async () => {
    const { db, env } = seeded();
    const kept = await addKey(db);
    const expired = await addKey(db, { expiresAt: 1_000 });
    const future = Math.floor(Date.now() / 1000) + 3600;
    const cookie = `ck:${ORG}:${USER}:${future}:0011223344556677`;
    const stale = `ck:${ORG}:${USER}:1000:0011223344556677`;
    const stranger = `ck:${ORG}:user_someone:${future}:0011223344556677`;
    expect(await check(env, { check: [kept.id, expired.id, "key-deleted", cookie, stale, stranger] })).toEqual({ revoked: [expired.id, "key-deleted", stale, stranger] });
  });

  it("tells managed agents when a key is deleted or a cookie signs out", async () => {
    const { db, env } = seeded();
    const { id } = await addKey(db);
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const cookie = await sessionCookie();
    for (const request of [
      new Request(`${ORIGIN}/api/dashboard/api-keys/${id}`, { method: "DELETE", headers: { cookie } }),
      new Request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie } }),
    ]) {
      const { ctx, settle } = settlingCtx();
      expect((await worker.fetch(request, env, ctx)).status).toBeLessThan(300);
      await settle();
    }
    const revokes = (fetchMock.mock.calls as [string, RequestInit][])
      .filter(([url]) => String(url) === `${BLUE}/v1/internal/live/revoke`)
      .map(([, init]) => {
        expect(claims(new Headers(init.headers).get("x-opencomputer-agent-token")!).org_id).toBe(ORG);
        return JSON.parse(String(init.body)) as { org: string; credentialId: string };
      });
    expect(revokes).toHaveLength(2);
    expect(revokes[0]).toEqual({ org: ORG, credentialId: id });
    expect(revokes[1].org).toBe(ORG);
    expect(revokes[1].credentialId).toMatch(new RegExp(`^ck:${ORG}:${USER}:\\d+:[0-9a-f]{16}$`));
  });
});

describe("the Mac app's sign-in: PKCE, refresh, devices", () => {
  const REDIRECT = "http://127.0.0.1:53682/callback";

  async function pkce(): Promise<{ verifier: string; challenge: string }> {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    return { verifier, challenge };
  }

  function authorizeURL(challenge: string, redirect = REDIRECT): string {
    const u = new URL(`${ORIGIN}/auth/app/authorize`);
    u.search = new URLSearchParams({
      response_type: "code",
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-1",
      device_name: "Igor's MacBook",
    }).toString();
    return u.toString();
  }

  const tokenRequest = (fields: Record<string, string>) =>
    new Request(`${ORIGIN}/auth/app/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

  async function codeFor(env: Env, challenge: string): Promise<string> {
    const res = await worker.fetch(new Request(authorizeURL(challenge), { headers: { cookie: await sessionCookie() } }), env, ctx());
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    return back.searchParams.get("code")!;
  }

  it("sends a signed-out browser to sign in first, and refuses any redirect but the loopback", async () => {
    const { env } = seeded();
    const { challenge } = await pkce();
    const res = await worker.fetch(new Request(authorizeURL(challenge)), env, ctx());
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location")!);
    expect(login.pathname).toBe("/auth/login");
    expect(login.searchParams.get("returnTo")).toBe(authorizeURL(challenge).slice(ORIGIN.length));
    for (const redirect of ["http://localhost:53682/callback", "https://127.0.0.1:53682/callback", "http://127.0.0.1:53682/other", "http://127.0.0.1/callback", "opencomputer://callback"]) {
      const bad = await worker.fetch(new Request(authorizeURL(challenge, redirect), { headers: { cookie: await sessionCookie() } }), env, ctx());
      expect(bad.status).toBe(400);
    }
  });

  it("runs code, token, refresh and revoke end to end", async () => {
    const { db, env } = seeded();
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL) =>
      String(url).endsWith("/computer/live") ? upgraded() : Response.json({ protocol: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // A wrong verifier spends the code and gets nothing.
    const other = await pkce();
    const spent = await codeFor(env, other.challenge);
    const wrong = await worker.fetch(tokenRequest({ grant_type: "authorization_code", code: spent, code_verifier: (await pkce()).verifier, redirect_uri: REDIRECT }), env, ctx());
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");

    // The code.
    const { verifier, challenge } = await pkce();
    const code = await codeFor(env, challenge);
    expect(code).toBeTruthy();

    // The token.
    const exchange = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT };
    const res = await worker.fetch(tokenRequest(exchange), env, ctx());
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; device_id: string; token_type: string };
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 900 });
    expect(tokens.device_id).toMatch(/^dev_/);
    const access = claims(tokens.access_token);
    expect(access).toMatchObject({ org_id: ORG, user_id: USER, dev: tokens.device_id });
    expect((access.exp as number) - (access.iat as number)).toBe(900);
    expect((await worker.fetch(tokenRequest(exchange), env, ctx())).status).toBe(400); // single use

    // The access token is a member's credential on the computer API, via app.
    expect((await worker.fetch(api("/feed", { headers: { authorization: `Bearer ${tokens.access_token}` } }), env, ctx())).status).toBe(200);
    expect(assertedPrincipal(fetchMock, fetchMock.mock.calls.length - 1)).toMatchObject({
      subject: SUBJECT,
      kind: "member",
      via: "app",
      scopes: ["sessions:read", "sessions:write", "asks:answer", "work:read", "work:write"],
      credential: { id: tokens.device_id, expiresAt: (access.exp as number) * 1000 },
    });
    // ...and on /live, but never as a cookie.
    expect((await worker.fetch(liveRequest({ "sec-websocket-protocol": `oc.live.v1, oc.bearer.${tokens.access_token}` }), env, ctx())).status).toBe(101);
    expect((await worker.fetch(api("/feed", { headers: { cookie: `oc_session=${tokens.access_token}` } }), env, ctx())).status).toBe(401);

    // The refresh rotates.
    const refreshed = await worker.fetch(tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }), env, ctx());
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string; device_id: string };
    expect(next.device_id).toBe(tokens.device_id);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await worker.fetch(tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }), env, ctx())).status).toBe(400);

    // Live's check knows the device and its token.
    const liveCheck = async (body: { check?: string[]; token?: string }) => {
      const credentials = new LiveCredentials(ctx(), env);
      return body.token !== undefined ? { principal: await credentials.principal(body.token) } : { revoked: await credentials.revoked(body.check!) };
    };
    expect(await liveCheck({ token: next.access_token })).toMatchObject({ principal: { via: "app", credential: { id: tokens.device_id } } });
    expect(await liveCheck({ check: [tokens.device_id] })).toEqual({ revoked: [] });

    // The devices, and the revoke.
    const cookie = await sessionCookie();
    const list = await worker.fetch(new Request(`${ORIGIN}/auth/app/devices`, { headers: { cookie } }), env, ctx());
    expect(await list.json()).toMatchObject({ devices: [{ id: tokens.device_id, name: "Igor's MacBook" }] });
    const devicePath = `${ORIGIN}/auth/app/devices/${tokens.device_id}`;
    expect((await worker.fetch(new Request(devicePath, { method: "DELETE", headers: { cookie } }), env, ctx())).status).toBe(401); // no Origin
    const { ctx: revokeCtx, settle } = settlingCtx();
    expect((await worker.fetch(new Request(devicePath, { method: "DELETE", headers: { cookie, origin: ORIGIN } }), env, revokeCtx)).status).toBe(204);
    await settle();
    const revoke = (fetchMock.mock.calls as [string, RequestInit][]).find(([url]) => String(url) === `${BLUE}/v1/internal/live/revoke`);
    expect(JSON.parse(String(revoke![1].body))).toEqual({ org: ORG, credentialId: tokens.device_id });

    expect((await worker.fetch(tokenRequest({ grant_type: "refresh_token", refresh_token: next.refresh_token }), env, ctx())).status).toBe(400);
    expect(await liveCheck({ check: [tokens.device_id] })).toEqual({ revoked: [tokens.device_id] });
    expect(await liveCheck({ token: next.access_token })).toEqual({ principal: null });
    expect((await worker.fetch(liveRequest({ "sec-websocket-protocol": `oc.live.v1, oc.bearer.${next.access_token}` }), env, ctx())).status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_devices").get()).toEqual({ n: 0 });
  });
});
