import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { slackRedirectUri } from "../src/actors/computer/config.js";
import {
  COMPUTER_SLACK_SCOPES,
  SLACK_CALLBACK_PATH,
  claudeCredentialKind,
  handleSetup,
  slackManifest,
  type SetupDeps,
  type SetupStatus,
  type SetupWrite,
} from "../src/selfhost/setup.js";

const TOKEN = "setup-token-0123456789abcdef";
const HOST_TOKEN = "sph_hosttokenvalue0123456789";
const API_KEY = "sk-ant-api03-SECRETVALUEabcdefghijklmnop";
const OAUTH = "sk-ant-oat01-SECRETOAUTHabcdefghijklmnop";
const ORIGIN = "https://gw.example.test";

/** An in-memory store shaped like account.ts: it keeps the values, status shows only whether they are set. */
function fakeDeps(over: Partial<SetupDeps> = {}) {
  const kept: Record<string, string> = {};
  let status: SetupStatus = { claude: { set: false }, hostsAcknowledged: false, slack: null, oidc: null, workos: null, github: null };
  const calls = { modelKeyChanged: 0, writes: [] as SetupWrite[] };
  const deps: SetupDeps = {
    setupToken: TOKEN,
    open: false,
    publicUrl: ORIGIN,
    org: "org_selfhost",
    host: { url: "ws://127.0.0.1:8080/v1/computer/host?organizationId=org_selfhost", token: HOST_TOKEN },
    hostConnected: async () => false,
    modelKeyChanged: async () => {
      calls.modelKeyChanged += 1;
    },
    slackLinked: async () => ({ installed: false }),
    slackInstall: async () => ({ url: "https://slack.com/oauth/v2/authorize?x=1" }),
    store: {
      status: async () => structuredClone(status),
      write: async (w) => {
        calls.writes.push(w);
        switch (w.step) {
          case "claude":
            kept.claude = w.token;
            status.claude = { set: true, kind: w.kind, at: "2026-11-27T00:00:00.000Z" };
            break;
          case "claude-delete":
            status.claude = { set: false };
            break;
          case "hosts-ack":
            status.hostsAcknowledged = true;
            break;
          case "slack":
            if (w.clientSecret) kept.slackSecret = w.clientSecret;
            if (w.signingSecret) kept.slackSigning = w.signingSecret;
            status.slack = { clientId: w.clientId, clientSecret: !!kept.slackSecret, signingSecret: !!kept.slackSigning };
            break;
          case "oidc":
            if (w.clientSecret) kept.oidc = w.clientSecret;
            status.oidc = { issuer: w.issuer, clientId: w.clientId, clientSecret: !!kept.oidc };
            break;
          case "workos":
            if (w.apiKey) kept.workos = w.apiKey;
            status.workos = { clientId: w.clientId, apiKey: !!kept.workos };
            break;
          case "github":
            if (w.privateKey) kept.ghKey = w.privateKey;
            if (w.webhookSecret) kept.ghHook = w.webhookSecret;
            status.github = { appId: w.appId, slug: w.slug, privateKey: !!kept.ghKey, webhookSecret: !!kept.ghHook };
            break;
        }
      },
    },
    ...over,
  };
  return { deps, calls, kept, setStatus: (s: Partial<SetupStatus>) => (status = { ...status, ...s }) };
}

const bearer = { authorization: `Bearer ${TOKEN}` };
const form = (body: Record<string, string>) => new URLSearchParams(body).toString();
const post = (path: string, body: Record<string, string>, headers: Record<string, string> = bearer) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form(body) });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });

async function login(deps: SetupDeps): Promise<{ cookie: string; csrf: string }> {
  const response = await handleSetup(post("/setup/login", { token: TOKEN }, {}), deps);
  expect(response.status).toBe(303);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Strict/);
  expect(setCookie).toMatch(/Secure/);
  expect(setCookie).toMatch(/Path=\/setup/);
  expect(setCookie).not.toContain(TOKEN);
  const cookie = setCookie.split(";")[0]!;
  const page = await (await handleSetup(get("/setup", { cookie }), deps)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
  return { cookie, csrf };
}

describe("selfhost /setup", () => {
  it("asks an unauthenticated visitor to sign in, and refuses POSTs", async () => {
    const { deps, calls } = fakeDeps();
    const page = await handleSetup(get("/setup"), deps);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('action="/setup/login"');
    const write = await handleSetup(post("/setup/claude", { token: API_KEY }, {}), deps);
    expect(write.status).toBe(401);
    expect(calls.writes).toEqual([]);
  });

  it("rejects a wrong token, as bearer, sign-in or forged cookie", async () => {
    const { deps, calls } = fakeDeps();
    expect((await handleSetup(get("/setup", { authorization: "Bearer nope" }), deps)).status).toBe(401);
    const signIn = await handleSetup(post("/setup/login", { token: "nope" }, {}), deps);
    expect(signIn.status).toBe(401);
    expect(signIn.headers.get("set-cookie")).toBeNull();
    expect((await handleSetup(get("/setup", { cookie: "oc_setup=9999999999.forged" }), deps)).status).toBe(401);
    expect((await handleSetup(post("/setup/claude", { token: API_KEY }, { authorization: "Bearer nope" }), deps)).status).toBe(401);
    expect(calls.writes).toEqual([]);
  });

  it("is unavailable without SETUP_TOKEN", async () => {
    const { deps } = fakeDeps({ setupToken: undefined });
    expect((await handleSetup(get("/setup", bearer), deps)).status).toBe(404);
  });

  it("signs in with the form; cookie POSTs need the CSRF field and this origin", async () => {
    const { deps, calls } = fakeDeps();
    const { cookie, csrf } = await login(deps);
    expect((await handleSetup(post("/setup/hosts/ack", {}, { cookie }), deps)).status).toBe(403);
    expect((await handleSetup(post("/setup/hosts/ack", { csrf: "wrong" }, { cookie }), deps)).status).toBe(403);
    expect((await handleSetup(post("/setup/hosts/ack", { csrf }, { cookie, origin: "https://evil.test" }), deps)).status).toBe(403);
    expect(calls.writes).toEqual([]);
    expect((await handleSetup(post("/setup/hosts/ack", { csrf }, { cookie, origin: ORIGIN }), deps)).status).toBe(200);
    expect(calls.writes).toEqual([{ step: "hosts-ack" }]);
  });

  it("expires the cookie", async () => {
    const { deps } = fakeDeps();
    const { cookie } = await login(deps);
    const later = { ...deps, now: () => Date.now() + 13 * 3600_000 };
    expect((await handleSetup(get("/setup", { cookie }), later)).status).toBe(401);
  });

  it("stores the Claude credential, tells the Computer, and never shows it", async () => {
    const { deps, calls, kept } = fakeDeps();
    const saved = await handleSetup(post("/setup/claude", { token: OAUTH }), deps);
    expect(saved.status).toBe(200);
    expect(kept.claude).toBe(OAUTH);
    expect(calls.modelKeyChanged).toBe(1);
    const body = await saved.text();
    expect(body).toContain("Claude subscription token");
    expect(body).not.toContain(OAUTH);
    expect(body).not.toContain("SECRETOAUTH");
    expect((await handleSetup(post("/setup/claude", { token: "not-a-key" }), deps)).status).toBe(400);
    expect(calls.writes).toHaveLength(1);
  });

  it("never writes stored secrets or the host token into a page", async () => {
    const { deps } = fakeDeps();
    const secrets = { slack: "slack-client-secret-XYZ", signing: "slack-signing-secret-XYZ", oidc: "oidc-secret-XYZ", workos: "sk_workos_XYZ", hook: "gh-hook-XYZ" };
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nPEMSECRETXYZ\n-----END RSA PRIVATE KEY-----";
    const responses = [
      await handleSetup(post("/setup/claude", { token: API_KEY }), deps),
      await handleSetup(post("/setup/slack", { client_id: "123.456", client_secret: secrets.slack, signing_secret: secrets.signing }), deps),
      await handleSetup(post("/setup/sso/oidc", { issuer: "https://idp.example.test", client_id: "abc", client_secret: secrets.oidc }), deps),
      await handleSetup(post("/setup/sso/workos", { client_id: "client_01", api_key: secrets.workos }), deps),
      await handleSetup(post("/setup/github", { app_id: "42", slug: "my-app", private_key: pem, webhook_secret: secrets.hook }), deps),
      await handleSetup(get("/setup", bearer), deps),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const body = await response.text();
      for (const value of [TOKEN, HOST_TOKEN, API_KEY, "SECRETVALUE", ...Object.values(secrets), "PEMSECRETXYZ"]) expect(body).not.toContain(value);
      for (const value of response.headers.values()) expect(value).not.toContain(TOKEN);
    }
    // The install command shows the host token masked; only the explicit reveal (a POST) has it.
    const page = await (await handleSetup(get("/setup", bearer), deps)).text();
    expect(page).toContain("sph_••••");
    const reveal = await handleSetup(post("/setup/hosts/reveal", {}), deps);
    expect(await reveal.text()).toContain(HOST_TOKEN);
  });

  it("keeps a stored secret when its field is left empty", async () => {
    const { deps, kept } = fakeDeps();
    await handleSetup(post("/setup/slack", { client_id: "1.2", client_secret: "first", signing_secret: "sign" }), deps);
    await handleSetup(post("/setup/slack", { client_id: "1.3", client_secret: "", signing_secret: "" }), deps);
    expect(kept.slackSecret).toBe("first");
    expect((await deps.store.status()).slack).toEqual({ clientId: "1.3", clientSecret: true, signingSecret: true });
  });

  it("locks with 404 once the credential is set and a host connected or acknowledged", async () => {
    const { deps } = fakeDeps();
    await handleSetup(post("/setup/claude", { token: API_KEY }), deps);
    expect((await handleSetup(get("/setup", bearer), deps)).status).toBe(200);
    const done = await handleSetup(post("/setup/hosts/ack", {}), deps);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("SP_SETUP_OPEN=1");
    for (const request of [get("/setup", bearer), get("/setup"), post("/setup/claude", { token: OAUTH }), post("/setup/login", { token: TOKEN }, {})]) {
      expect((await handleSetup(request, deps)).status).toBe(404);
    }

    const connected = fakeDeps({ hostConnected: async () => true });
    connected.setStatus({ claude: { set: true, kind: "api-key", at: "x" } });
    expect((await handleSetup(get("/setup", bearer), connected.deps)).status).toBe(404);
  });

  it("SP_SETUP_OPEN=1 reopens a completed setup", async () => {
    const { deps, setStatus } = fakeDeps({ open: true, hostConnected: async () => true });
    setStatus({ claude: { set: true, kind: "api-key", at: "x" } });
    const page = await handleSetup(get("/setup", bearer), deps);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("complete");
    expect((await handleSetup(post("/setup/claude/delete", {}), deps)).status).toBe(200);
  });

  it("sends a Slack install to Slack's authorize URL", async () => {
    const { deps } = fakeDeps();
    const response = await handleSetup(post("/setup/slack/install", {}), deps);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^https:\/\/slack\.com\//);
  });

  it("sets protective headers", async () => {
    const { deps } = fakeDeps();
    const response = await handleSetup(get("/setup", bearer), deps);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("tells API keys from subscription tokens", () => {
    expect(claudeCredentialKind(API_KEY)).toBe("api-key");
    expect(claudeCredentialKind(OAUTH)).toBe("oauth");
    expect(claudeCredentialKind("sk-or-v1-abcdefghijklmnopqrstuv")).toBeNull();
    expect(claudeCredentialKind("sk-ant-short")).toBeNull();
  });

  it("builds the Slack manifest for this gateway's Computer routes", async () => {
    const manifest = slackManifest(ORIGIN) as {
      settings: { event_subscriptions: { request_url: string }; interactivity: { request_url: string } };
      oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } };
    };
    expect(manifest.settings.event_subscriptions.request_url).toBe(`${ORIGIN}/v1/webhooks/computer/slack/events`);
    expect(manifest.settings.interactivity.request_url).toBe(`${ORIGIN}/v1/webhooks/computer/slack/interactivity`);
    expect(manifest.oauth_config.redirect_urls).toEqual([`${ORIGIN}${SLACK_CALLBACK_PATH}`]);
    expect(manifest.oauth_config.scopes.bot).toEqual(expect.arrayContaining(COMPUTER_SLACK_SCOPES.split(",")));
    const { deps } = fakeDeps();
    const served = await handleSetup(get("/setup/slack/manifest.json", bearer), deps);
    expect(served.status).toBe(200);
    expect(((await served.json()) as { oauth_config: { redirect_urls: string[] } }).oauth_config.redirect_urls).toEqual([`${ORIGIN}${SLACK_CALLBACK_PATH}`]);
  });

  it("keeps the Slack scopes and callback path equal to the hosted ones", () => {
    const production = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../wrangler.production.jsonc"), "utf8");
    expect(/"SLACK_COMPUTER_SCOPES":\s*"([^"]+)"/.exec(production)?.[1]).toBe(COMPUTER_SLACK_SCOPES);
    expect(slackRedirectUri({ COMPUTER_PUBLIC_ORIGIN: ORIGIN } as never)).toBe(`${ORIGIN}${SLACK_CALLBACK_PATH}`);
  });
});
