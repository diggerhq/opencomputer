import { beforeEach, describe, expect, it } from "vitest";

import { SECRET_VIEW, buttonId, decodeButtonId, parseSecretCommand, type SubmittedView } from "../src/computer/secrets.js";
import { SecretsStore } from "../src/computer/secrets-store.js";
import { credentialHint, parseVariableCommand } from "../src/computer/variables.js";
import { secretNameProblem } from "../src/computer/secrets.js";
import type { SlackResult } from "../src/computer/slack.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const SESSION = { key: "T1:C1:100.1", ownerId: "U_OWNER", channelId: "C1", threadTs: "100.1" };

let calls: Array<{ method: string; body: Record<string, unknown> }>;
let pushes: Array<{ key?: string; owner?: string }>;
let woken: Array<{ key: string; userId: string; text: string }>;
let guests: Set<string>;
let s: SecretsStore;

beforeEach(() => {
  calls = [];
  pushes = [];
  woken = [];
  guests = new Set(["U_GUEST", "U_EXTERNAL"]);
  s = new SecretsStore({
    sql: sqlStorage(),
    encryptionKey: () => KEY,
    teamId: () => "T1",
    slack: async (method, body): Promise<SlackResult> => {
      calls.push({ method, body });
      if (method === "users.info") {
        const user = String(body.user);
        if (user === "U_EXTERNAL") return { ok: true, user: { team_id: "T_OTHER" } };
        return { ok: true, user: { team_id: "T1", is_restricted: guests.has(user) } };
      }
      return { ok: true, ts: "200.1" };
    },
    session: (key) => (key === SESSION.key ? SESSION : undefined),
    push: async (which) => void pushes.push(which),
    wake: async (session, userId, text) => void woken.push({ key: session.key, userId, text }),
  });
});

const last = (method: string) => calls.filter((c) => c.method === method).at(-1)?.body;
const inSession = (userId: string) => ({ userId, channelId: "C1", threadTs: "100.1", session: { key: SESSION.key, ownerId: SESSION.ownerId } });
function submission(name: string, value: string, scope: string, meta: Record<string, string> = { k: SESSION.key, ch: "C1", th: "100.1" }): SubmittedView {
  return {
    callback_id: SECRET_VIEW,
    private_metadata: JSON.stringify(meta),
    state: {
      values: {
        name: { v: { value: name } },
        value: { v: { value } },
        scope: { v: { selected_option: { value: scope } } },
        opts: { v: { selected_options: [] } },
      },
    },
  };
}
async function submit(view: SubmittedView, userId: string) {
  const r = await s.submit(view, userId);
  await r.after?.();
  return r;
}

describe("computer session secrets (ported from dash-cal)", () => {
  it("!secret NAME answers with a private button for this session, and nothing else", async () => {
    await s.command(parseSecretCommand("!secret MONID_API_KEY")!, inSession("U_OWNER"));
    const eph = last("chat.postEphemeral")!;
    expect(eph).toMatchObject({ channel: "C1", user: "U_OWNER", thread_ts: "100.1" });
    const button = (eph.blocks as Array<{ elements?: Array<{ action_id: string }> }>)[1]!.elements![0]!.action_id;
    expect(decodeButtonId(button)).toEqual({ k: SESSION.key, n: "MONID_API_KEY" });
    expect(calls.filter((c) => c.method === "chat.postMessage")).toEqual([]);
  });

  it("the button opens a modal; the workspace scope for full members, not guests or other organizations", async () => {
    const id = buttonId({ k: SESSION.key, n: "API" });
    await s.open(id, "trig", { userId: "U_GUEST", channelId: "C1" });
    const view = last("views.open") as { trigger_id: string; view: { blocks: Array<{ block_id?: string; element?: { options?: Array<{ value: string }> } }> } };
    expect(view.trigger_id).toBe("trig");
    expect(view.view.blocks.find((b) => b.block_id === "scope")!.element!.options!.map((o) => o.value)).toEqual(["session", "user"]);
    await s.open(id, "trig2", { userId: "U_OWNER", channelId: "C1" });
    const member = last("views.open") as typeof view;
    expect(member.view.blocks.find((b) => b.block_id === "scope")!.element!.options!.map((o) => o.value)).toEqual(["session", "user", "workspace"]);
  });

  it("stores each scope, gives a session the narrowest, and pushes to who it applies to", async () => {
    expect((await submit(submission("API", "ws-value-1", "workspace"), "U_MEMBER")).errors).toBeUndefined();
    expect(pushes.at(-1)).toEqual({});
    await submit(submission("API", "mine-value", "user"), "U_OWNER");
    expect(pushes.at(-1)).toEqual({ owner: "U_OWNER" });
    await submit(submission("API", "sess-value", "session"), "U_OTHER");
    expect(pushes.at(-1)).toEqual({ key: SESSION.key });
    await submit(submission("ONLY_WS", "ws-only-1", "workspace"), "U_MEMBER");

    expect(await s.forSession(SESSION.key, "U_OWNER")).toEqual([
      { name: "API", value: "sess-value", scope: "session" },
      { name: "ONLY_WS", value: "ws-only-1", scope: "workspace" },
    ]);
    expect(await s.forSession("T1:C1:999.9", "U_OWNER")).toContainEqual({ name: "API", value: "mine-value", scope: "user" });
    expect(await s.forSession("T1:C1:999.9", "U_SOMEONE")).toContainEqual({ name: "API", value: "ws-value-1", scope: "workspace" });
    // The thread hears who set what, never the value.
    const notes = calls.filter((c) => c.method === "chat.postMessage").map((c) => String(c.body.text));
    expect(notes.join("\n")).not.toMatch(/value/);
  });

  it("refuses the workspace scope to guests and other organizations, and a session scope with no session", async () => {
    expect((await s.submit(submission("X", "v", "workspace"), "U_GUEST")).errors).toHaveProperty("scope");
    expect((await s.submit(submission("X", "v", "workspace"), "U_EXTERNAL")).errors).toHaveProperty("scope");
    expect((await s.submit(submission("X", "v", "session", { ch: "C1" }), "U_OWNER")).errors).toHaveProperty("scope");
    expect(await s.forSession(SESSION.key, "U_OWNER")).toEqual([]);
  });

  it("!secret lists names only; a guest cannot remove workspace secrets, a member can", async () => {
    await submit(submission("SHARED", "shared-value", "workspace"), "U_MEMBER");
    await submit(submission("MINE", "mine-value", "user"), "U_OWNER");
    await s.command({ kind: "list" }, inSession("U_OWNER"));
    const listing = String(last("chat.postEphemeral")!.text);
    expect(listing).toMatch(/SHARED/);
    expect(listing).toMatch(/MINE/);
    expect(listing).not.toMatch(/shared-value|mine-value/);

    await s.command({ kind: "rm", name: "SHARED" }, inSession("U_GUEST"));
    expect(String(last("chat.postEphemeral")!.text)).toMatch(/only full members/);
    await s.command({ kind: "rm", name: "SHARED" }, inSession("U_OWNER"));
    expect(String(last("chat.postEphemeral")!.text)).toMatch(/Removed/);
    expect((await s.forSession(SESSION.key, "U_OWNER")).map((x) => x.name)).toEqual(["MINE"]);
  });

  it("request_secret posts a button in the thread; setting it updates that message and wakes the session", async () => {
    await s.request(SESSION.key, { name: "GCP_SA", reason: "deploy to staging", file: true });
    const req = last("chat.postMessage")!;
    expect(req).toMatchObject({ channel: "C1", thread_ts: "100.1" });
    await submit(submission("GCP_SA", "{}", "session", { k: SESSION.key, ch: "C1", th: "100.1", rq: "300.1" }), "U_OWNER");
    expect(last("chat.update")).toMatchObject({ channel: "C1", ts: "300.1", blocks: [] });
    expect(woken).toEqual([{ key: SESSION.key, userId: "U_OWNER", text: expect.stringMatching(/^Secret \$GCP_SA is set/) }]);
    await expect(s.request(SESSION.key, { name: "PATH", reason: "x" })).rejects.toThrow(/reserved/);
  });
});


describe("computer session variables (!var)", () => {
  const say = async (text: string, ctx = inSession("U_OWNER")) => {
    await s.variableCommand(parseVariableCommand(text)!, ctx, text);
    return String(last("chat.postEphemeral")!.text);
  };

  it("sets a variable flagged for the runner, shows its value and pushes it; organization scope for full members only", async () => {
    expect(await say("!var ORG_NAME acme-public-org org", inSession("U_GUEST"))).toMatch(/Only full members/);
    expect(pushes).toEqual([]);
    expect(await say("!var ORG_NAME acme-public-org org")).toMatch(/Set `ORG_NAME` = `acme-public-org`/);
    expect(pushes.at(-1)).toEqual({});
    expect(await s.forSession(SESSION.key, "U_OWNER")).toEqual([{ name: "ORG_NAME", value: "acme-public-org", scope: "workspace", variable: true }]);
    await say("!var REGION=eu-west-1");
    expect(pushes.at(-1)).toEqual({ key: SESSION.key });
    const listing = await say("!vars");
    expect(listing).toMatch(/REGION` = `eu-west-1` · this session/);
    expect(listing).toMatch(/ORG_NAME` = `acme-public-org` · the organization/);
  });

  it("never replaces or shows a secret; a secret may replace a variable; !secret and !var each see their own", async () => {
    await submit(submission("API_KEY", "sk-secret-123", "session"), "U_OWNER");
    expect(await say("!var API_KEY plain")).toMatch(/is a secret/);
    expect(JSON.stringify(calls)).not.toMatch(/sk-secret-123/);
    expect((await s.forSession(SESSION.key, "U_OWNER"))[0]).toEqual({ name: "API_KEY", value: "sk-secret-123", scope: "session" });

    await say("!var HOST db.internal");
    expect(await say("!vars")).not.toMatch(/API_KEY/);
    await s.command({ kind: "list" }, inSession("U_OWNER"));
    expect(String(last("chat.postEphemeral")!.text)).not.toMatch(/HOST/);
    await s.command({ kind: "rm", name: "HOST" }, inSession("U_OWNER"));
    expect(String(last("chat.postEphemeral")!.text)).not.toMatch(/Removed/);

    await submit(submission("HOST", "now-a-secret", "session"), "U_OWNER");
    expect((await s.forSession(SESSION.key, "U_OWNER")).find((x) => x.name === "HOST")).toEqual({ name: "HOST", value: "now-a-secret", scope: "session" });
  });

  it("asks before keeping a credential-looking variable; \"Set it anyway\" sets it, checks and all", async () => {
    expect(await say("!var DEPLOY_TOKEN abc123")).toMatch(/Not set: the name `DEPLOY_TOKEN` sounds like a credential/);
    const button = (last("chat.postEphemeral")!.blocks as Array<{ elements?: Array<{ action_id: string; value: string }> }>).flatMap((b) => b.elements ?? [])[0]!;
    expect(button).toMatchObject({ action_id: `v:${SESSION.key}`, value: "!var DEPLOY_TOKEN abc123" });
    expect(pushes).toEqual([]);
    const answers: string[] = [];
    await s.confirmVariable(button.value, inSession("U_OWNER"), async (t) => void answers.push(t));
    expect(answers.at(-1)).toMatch(/Set `DEPLOY_TOKEN` = `abc123` for this session/);
    expect(await s.forSession(SESSION.key, "U_OWNER")).toEqual([{ name: "DEPLOY_TOKEN", value: "abc123", scope: "session", variable: true }]);
    await s.confirmVariable("!var ORG_NAME x org", inSession("U_GUEST"), async (t) => void answers.push(t));
    expect(answers.at(-1)).toMatch(/Only full members/);
  });

  it("flags credential-looking names and values, not ordinary ones", () => {
    for (const n of ["DEPLOY_TOKEN", "STRIPE_KEY", "db_password", "SENTRY_DSN"]) expect(credentialHint(n, "x")).toMatch(/sounds like a credential/);
    for (const v of ["sk_live_abcdefghijkl", `ghp_${"a".repeat(36)}`, "xoxb-1234-5678-abcdef", "AKIAABCDEFGHIJKLMNOP", "postgres://me:hunter2@db/x"])
      expect(credentialHint("X", v)).toMatch(/looks like/);
    for (const [n, v] of [["ORG_NAME", "acme"], ["MONKEY", "x"], ["URL", "https://a.example/x?y=1"], ["RUN_ID", "123e4567-e89b-12d3-a456-426614174000"]])
      expect(credentialHint(n!, v!)).toBeUndefined();
  });

  it("refuses names that redirect traffic or run code, in any case", () => {
    for (const n of ["HTTPS_PROXY", "https_proxy", "PROMPT_COMMAND", "PYTHONSTARTUP", "NODE_EXTRA_CA_CERTS"]) expect(secretNameProblem(n)).toMatch(/reserved/);
  });

  it("marks a variable overridden by a narrower secret, and removes one", async () => {
    await say("!var ENDPOINT https://api.example.com me");
    await submit(submission("ENDPOINT", "secret-endpoint", "session"), "U_OWNER");
    expect(await say("!vars")).toMatch(/ENDPOINT` = `https:\/\/api.example.com` · just you · overridden/);
    expect(await say("!var rm ENDPOINT")).toMatch(/No variable/);
    expect(await say("!var rm ENDPOINT me")).toMatch(/Removed `ENDPOINT`/);
    expect(pushes.at(-1)).toEqual({ owner: "U_OWNER" });
  });
});

describe("!var parsing", () => {
  it("parses set, list, rm and scopes, and refuses reserved names and empty values", () => {
    expect(parseVariableCommand("!secret X")).toBeNull();
    expect(parseVariableCommand("!vars")).toEqual({ kind: "list" });
    expect(parseVariableCommand("!var A b c org")).toEqual({ kind: "set", name: "A", value: "b c", scope: "workspace" });
    expect(parseVariableCommand("!var A `just me`")).toEqual({ kind: "set", name: "A", value: "just me" });
    expect(parseVariableCommand("!var rm A me")).toEqual({ kind: "rm", name: "A", scope: "user" });
    expect(parseVariableCommand("!var PATH /x")).toMatchObject({ kind: "bad" });
    expect(parseVariableCommand("!var A")).toMatchObject({ kind: "bad" });
  });
});

describe("!secret parsing", () => {
  it("parses set, list, rm with the organization scope, and refuses reserved names", () => {
    expect(parseSecretCommand("!secret")).toEqual({ kind: "list" });
    expect(parseSecretCommand("!secret API_KEY file")).toEqual({ kind: "set", name: "API_KEY", file: true });
    expect(parseSecretCommand("!secret rm API_KEY org")).toEqual({ kind: "rm", name: "API_KEY", scope: "workspace" });
    expect(parseSecretCommand("!secret rm API_KEY me")).toEqual({ kind: "rm", name: "API_KEY", scope: "user" });
    expect(parseSecretCommand("!secret ANTHROPIC_API_KEY")).toMatchObject({ kind: "bad" });
    expect(parseSecretCommand("hello")).toBeNull();
  });

  it("seals values bound to their scope, owner and name", async () => {
    const { sealSecret, openSecret } = await import("../src/computer/secrets.js");
    const sealed = await sealSecret("v", KEY, "user", "U1", "A");
    expect(await openSecret(sealed, KEY, "user", "U1", "A")).toBe("v");
    await expect(openSecret(sealed, KEY, "user", "U2", "A")).rejects.toThrow();
  });
});

describe("organization secrets over the Computer API (work 095 v1)", () => {
  const MEMBER = { member: "usr_01jabcdefghjkmnpqrstvwxyz0", userId: "user_1", name: "Owner", email: null, via: "dashboard" as const, client: null, scopes: [], requestId: "req_1" };
  const VALUE = "sk-live-do-not-show";

  it("any member sets, replaces and deletes; values never come back; every session gets it", async () => {
    const created = await s.api(MEMBER, { op: "secrets.put", name: "EXECUTOR_API_KEY", body: { value: VALUE } });
    expect(created).toMatchObject({ status: 201, body: { secret: { name: "EXECUTOR_API_KEY", layer: "organization", kind: "secret", file: false, updatedBy: { member: MEMBER.member, name: "Owner" } } } });
    expect(pushes).toEqual([{}]);
    expect((await s.forSession(SESSION.key, SESSION.ownerId)).find((x) => x.name === "EXECUTOR_API_KEY")?.value).toBe(VALUE);

    const replaced = await s.api({ ...MEMBER, via: "opc" }, { op: "secrets.put", name: "EXECUTOR_API_KEY", body: { value: "sk-new" } });
    expect(replaced.status).toBe(200);
    const listed = await s.api(MEMBER, { op: "secrets.list" });
    expect(JSON.stringify(listed)).not.toContain("sk-");
    expect(listed.body).toMatchObject({ secrets: [{ name: "EXECUTOR_API_KEY", createdBy: { member: MEMBER.member } }] });

    expect((await s.api(MEMBER, { op: "secrets.delete", name: "EXECUTOR_API_KEY" })).status).toBe(204);
    expect((await s.api(MEMBER, { op: "secrets.delete", name: "EXECUTOR_API_KEY" })).error?.code).toBe("secret_not_found");
    const events = (await s.api(MEMBER, { op: "secrets.events", name: "EXECUTOR_API_KEY" })).body as { events: Array<{ action: string; via: string }> };
    expect(events.events.map((e) => [e.action, e.via])).toEqual([["delete", "dashboard"], ["replace", "opc"], ["set", "dashboard"]]);
  });

  it("lists variables with their values, counts narrower copies that win, and records Slack changes too", async () => {
    await s.api(MEMBER, { op: "secrets.put", name: "OPENAI_BASE_URL", body: { value: "https://proxy.example", variable: true } });
    await submit(submission("OPENAI_KEY", "x", "workspace"), "U_OWNER");
    await submit(submission("OPENAI_KEY", "y", "session"), "U_OWNER");
    await submit(submission("OPENAI_KEY", "z", "user"), "U_OWNER");
    const { secrets } = (await s.api(MEMBER, { op: "secrets.list" })).body as { secrets: Array<Record<string, unknown>> };
    expect(secrets).toEqual([
      expect.objectContaining({ name: "OPENAI_BASE_URL", kind: "variable", value: "https://proxy.example" }),
      expect.objectContaining({ name: "OPENAI_KEY", kind: "secret", updatedBy: { slackUserId: "U_OWNER" }, overriddenIn: { threads: 1, people: 1 } }),
    ]);
    expect(secrets[1]).not.toHaveProperty("value");
    const events = (await s.api(MEMBER, { op: "secrets.events", name: "OPENAI_KEY" })).body as { events: Array<{ via: string }> };
    expect(events.events).toEqual([expect.objectContaining({ action: "set", via: "slack", actor: { slackUserId: "U_OWNER" } })]);
  });

  it("refuses reserved names, base URLs as secrets, bad bodies, and a full layer", async () => {
    const put = (name: string, body: unknown) => s.api(MEMBER, { op: "secrets.put", name, body });
    expect((await put("NODE_OPTIONS", { value: "x" })).error?.code).toBe("invalid_name");
    expect((await put("PIP_INDEX_URL", { value: "x", variable: true })).error?.code).toBe("invalid_name");
    expect((await put("OPENAI_BASE_URL", { value: "x" })).error?.code).toBe("invalid_name");
    expect((await put("A", {})).error).toMatchObject({ code: "invalid_request", field: "value" });
    expect((await put("A", { value: "x", file: true, variable: true })).error?.code).toBe("invalid_request");
    expect((await put("A", { value: "x".repeat(64 * 1024 + 1) })).status).toBe(413);
    for (let i = 0; i < 200; i++) await s.api({ ...MEMBER, member: `usr_${i}` }, { op: "secrets.put", name: `K${i}`, body: { value: "v" } });
    expect((await put("ONE_TOO_MANY", { value: "v" })).error?.code).toBe("limit_reached");
  });

  it("limits one caller to 30 changes a minute", async () => {
    for (let i = 0; i < 30; i++) expect((await s.api(MEMBER, { op: "secrets.put", name: `K${i}`, body: { value: "v" } })).status).toBe(201);
    expect((await s.api(MEMBER, { op: "secrets.put", name: "K30", body: { value: "v" } })).status).toBe(429);
  });
});
