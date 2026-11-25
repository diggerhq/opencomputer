import { beforeEach, describe, expect, it } from "vitest";
import { authenticateAppToken, appDeviceLive, handleAppAuth, parseAppCredentialId, type AppAuthDeps, type AppAuthEnv } from "./app_auth";

// See agent_feedback.test.ts for why the Node builtins are reached this way.
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
declare const process: { cwd(): string; getBuiltinModule(id: string): unknown };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => Database };
const { readFileSync } = process.getBuiltinModule("node:fs") as { readFileSync(path: string, enc: "utf8"): string };

// D1 over an in-memory SQLite, enough for the statements app_auth runs.
function d1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => db.prepare(sql).run(...args),
      };
      return stmt;
    },
  } as unknown as D1Database;
}

async function pkce() {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}

const ORIGIN = "https://edge.test";
const REDIRECT = "http://127.0.0.1:51234/callback";
let db: Database;
let env: AppAuthEnv;
let signedIn: { orgID: string; userID: string } | null;
let revoked: string[];
const deps: AppAuthDeps = {
  session: async () => signedIn,
  revoke: async (_org, id) => void revoked.push(id),
  waitUntil: () => {},
};

const call = (path: string, init?: RequestInit) => handleAppAuth(new Request(ORIGIN + path, init), env, new URL(ORIGIN + path).pathname, deps);
const post = (body: unknown) => call("/auth/app/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function authorizePath(challenge: string, extra = "") {
  return `/auth/app/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=state-1234&device_name=Igor%27s%20Mac${extra}`;
}

async function codeFor(challenge: string): Promise<string> {
  const res = await call(authorizePath(challenge), { method: "POST", headers: { origin: ORIGIN } });
  expect(res.status).toBe(303);
  const back = new URL(res.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("state-1234");
  return back.searchParams.get("code")!;
}

async function signIn() {
  const { verifier, challenge } = await pkce();
  const res = await post({ grant_type: "authorization_code", code: await codeFor(challenge), code_verifier: verifier, redirect_uri: REDIRECT });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; device_id: string; expires_in: number; principal: { org: string; subject: string } };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT);
           CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE org_memberships (org_id TEXT, user_id TEXT, role TEXT);
           INSERT INTO users VALUES ('u1', 'igor@example.com', 'Igor');
           INSERT INTO orgs VALUES ('o1', 'Acme');
           INSERT INTO org_memberships VALUES ('o1', 'u1', 'owner');`);
  db.exec(readFileSync(`${process.cwd()}/migrations/0025_app_devices.sql`, "utf8"));
  env = { OPENCOMPUTER_DB: d1(db), SESSION_JWT_SECRET: "test-secret" };
  signedIn = { orgID: "o1", userID: "u1" };
  revoked = [];
});

describe("the Mac app's sign-in", () => {
  it("authorize: sends a person with no cookie to the login, and back", async () => {
    signedIn = null;
    const res = await call(authorizePath((await pkce()).challenge));
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location")!);
    expect(login.pathname).toBe("/auth/login");
    expect(login.searchParams.get("returnTo")).toMatch(/^\/auth\/app\/authorize\?redirect_uri=/);
  });

  it("authorize: asks first, naming the account and the device, escaped", async () => {
    const res = await call(authorizePath((await pkce()).challenge).replace("Igor%27s%20Mac", "%3Cscript%3E"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("igor@example.com");
    expect(html).toContain("Acme");
    expect(html).not.toContain("<script>");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("authorize: refuses a redirect that is not the loopback listener, and a confirmation from another origin", async () => {
    for (const uri of ["https://evil.example/callback", "http://127.0.0.1:51234/other", "http://localhost:51234/callback", "http://127.0.0.1:80/callback", "http://127.0.0.1:51234@evil.example/callback"]) {
      const res = await call(authorizePath((await pkce()).challenge).replace(encodeURIComponent(REDIRECT), encodeURIComponent(uri)));
      expect(res.status, uri).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    const cross = await call(authorizePath((await pkce()).challenge), { method: "POST", headers: { origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
  });

  it("the code gives a token that authenticates as the member, once, and only with the verifier", async () => {
    const { verifier, challenge } = await pkce();
    const code = await codeFor(challenge);
    const wrong = await post({ grant_type: "authorization_code", code, code_verifier: (await pkce()).verifier, redirect_uri: REDIRECT });
    expect(wrong.status).toBe(400);
    const ok = await post({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(ok.status).toBe(200);
    const reply = (await ok.json()) as Awaited<ReturnType<typeof signIn>>;
    expect(reply.expires_in).toBe(900);
    expect(reply.principal.org).toBe("o1");
    const again = await post({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(again.status).toBe(400);

    const caller = await authenticateAppToken(reply.access_token, env);
    expect(caller?.principal).toMatchObject({ org: "o1", subject: reply.principal.subject, kind: "member", via: "app", admin: true });
    expect(parseAppCredentialId(caller!.principal.credential.id)).toBe(reply.device_id);
    expect(db.prepare("SELECT name FROM app_devices").get()).toEqual({ name: "Igor's Mac" });
    // The refresh token is stored as a hash.
    expect(JSON.stringify(db.prepare("SELECT * FROM app_devices").all())).not.toContain(reply.refresh_token);
    // A token under another secret, or the code itself, is nobody.
    expect(await authenticateAppToken(reply.access_token, { ...env, SESSION_JWT_SECRET: "other" })).toBeNull();
    expect(await authenticateAppToken(code, env)).toBeNull();
  });

  it("refresh gives a new access token for the same device", async () => {
    const first = await signIn();
    const res = await post({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { access_token: string; device_id: string; refresh_token?: string };
    expect(reply.device_id).toBe(first.device_id);
    expect(reply.refresh_token).toBeUndefined();
    expect(await authenticateAppToken(reply.access_token, env)).not.toBeNull();
    expect((await post({ grant_type: "refresh_token", refresh_token: "ocr_nope" })).status).toBe(400);
  });

  it("revoking the device ends the access token, the refresh token and its sockets", async () => {
    const first = await signIn();
    const list = await call("/auth/app/devices", { headers: { authorization: `Bearer ${first.access_token}` } });
    expect(((await list.json()) as { devices: { id: string }[] }).devices.map((d) => d.id)).toEqual([first.device_id]);

    const del = await call(`/auth/app/devices/${first.device_id}`, { method: "DELETE", headers: { authorization: `Bearer ${first.access_token}` } });
    expect(del.status).toBe(204);
    expect(revoked).toEqual([`app:${first.device_id}`]);
    expect(await authenticateAppToken(first.access_token, env)).toBeNull();
    expect(await appDeviceLive(first.device_id, env)).toBe(false);
    expect((await post({ grant_type: "refresh_token", refresh_token: first.refresh_token })).status).toBe(400);
  });

  it("leaving the organization ends both tokens", async () => {
    const first = await signIn();
    db.exec("DELETE FROM org_memberships");
    expect(await authenticateAppToken(first.access_token, env)).toBeNull();
    expect((await post({ grant_type: "refresh_token", refresh_token: first.refresh_token })).status).toBe(400);
  });
});
