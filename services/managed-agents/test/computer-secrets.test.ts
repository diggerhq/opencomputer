import { beforeEach, describe, expect, it } from "vitest";

import { SECRET_VIEW, buttonId, decodeButtonId, parseSecretCommand, type SubmittedView } from "../src/computer/secrets.js";
import { SecretsStore } from "../src/computer/secrets-store.js";
import { credentialHint, parseVariableCommand } from "../src/computer/variables.js";
import { secretNameProblem } from "../src/computer/secrets.js";
import type { SlackResult } from "../src/computer/slack.js";
import { driversCommandText } from "../src/computer/access.js";
import { LOOKUP_FAILED_TEXT, ThreadAccess } from "../src/computer/threads.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const SESSION = { key: "T1:C1:100.1", ownerId: "U_OWNER", channelId: "C1", threadTs: "100.1" };

let calls: Array<{ method: string; body: Record<string, unknown> }>;
let pushes: Array<{ key?: string; owner?: string }>;
let woken: Array<{ key: string; userId: string; text: string }>;
let guests: Set<string>;
let s: SecretsStore;
/** Who may write to SESSION (work 112); undefined: everyone. */
let drivers: string[] | undefined;

beforeEach(() => {
  calls = [];
  pushes = [];
  woken = [];
  drivers = undefined;
  guests = new Set(["U_GUEST", "U_EXTERNAL"]);
  const slack = async (method: string, body: Record<string, unknown>): Promise<SlackResult> => {
    calls.push({ method, body });
    if (method === "users.info") {
      const user = String(body.user);
      if (user === "U_DOWN") return { ok: false, error: "ratelimited" };
      if (user === "U_EXTERNAL") return { ok: true, user: { team_id: "T_OTHER" } };
      return { ok: true, user: { team_id: "T1", is_restricted: guests.has(user) } };
    }
    return { ok: true, ts: "200.1" };
  };
  // The Durable Object's one lookup of a person (threads.ts).
  const people = new ThreadAccess(slack, "T1");
  s = new SecretsStore({
    sql: sqlStorage(),
    encryptionKey: () => KEY,
    member: (userId) => people.member(userId),
    instructs: async (_key, userId) => !drivers || drivers.includes(userId),
    slack,
    session: (key) => (key === SESSION.key ? SESSION : undefined),
    push: async (which) => void pushes.push(which),
    linkOfSlack: (slackUserId) => LINKS[slackUserId],
    isAdmin: (member) => member === LINKS.U_ADMIN,
    name: async (slackUserId) => `Name of ${slackUserId}`,
    wake: async (session, userId, text) => void woken.push({ key: session.key, userId, text }),
  });
});

/** Slack users linked to organization members; anyone else (U_NOLINK, …) linked none. */
const LINKS: Record<string, string> = {
  U_OWNER: "usr_01jabcdefghjkmnpqrstvwxyz0",
  U_OTHER: "usr_01jothermemberxxxxxxxxxxxx",
  U_ADMIN: "usr_01jadminmemberxxxxxxxxxxxx",
  // A Slack guest linked to an admin: not a full member, so not an admin in Slack.
  U_GUEST: "usr_01jadminmemberxxxxxxxxxxxx",
};
/** The refusal a Slack user gets for the organization scope (2026-11-26: organization admins only). */
const ORG_ADMINS = /only organization admins/i;
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

  it("the button opens a modal; the workspace scope only for full members linked to an organization admin", async () => {
    const id = buttonId({ k: SESSION.key, n: "API" });
    await s.open(id, "trig", { userId: "U_GUEST", channelId: "C1" });
    const view = last("views.open") as { trigger_id: string; view: { blocks: Array<{ block_id?: string; element?: { options?: Array<{ value: string }> } }> } };
    expect(view.trigger_id).toBe("trig");
    expect(view.view.blocks.find((b) => b.block_id === "scope")!.element!.options!.map((o) => o.value)).toEqual(["session", "user"]);
    await s.open(id, "trig2", { userId: "U_OWNER", channelId: "C1" });
    const member = last("views.open") as typeof view;
    expect(member.view.blocks.find((b) => b.block_id === "scope")!.element!.options!.map((o) => o.value)).toEqual(["session", "user"]);
    await s.open(id, "trig3", { userId: "U_ADMIN", channelId: "C1" });
    const admin = last("views.open") as typeof view;
    expect(admin.view.blocks.find((b) => b.block_id === "scope")!.element!.options!.map((o) => o.value)).toEqual(["session", "user", "workspace"]);
  });

  it("stores each scope, gives a session the narrowest, and pushes to who it applies to", async () => {
    expect((await submit(submission("API", "ws-value-1", "workspace"), "U_ADMIN")).errors).toBeUndefined();
    expect(pushes.at(-1)).toEqual({});
    await submit(submission("API", "mine-value", "user"), "U_OWNER");
    expect(pushes.at(-1)).toEqual({ owner: "U_OWNER" });
    await submit(submission("API", "sess-value", "session"), "U_OTHER");
    expect(pushes.at(-1)).toEqual({ key: SESSION.key });
    await submit(submission("ONLY_WS", "ws-only-1", "workspace"), "U_ADMIN");

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

  it("refuses the workspace scope to all but admins (guests, other organizations, members, unlinked), and a session scope with no session", async () => {
    for (const who of ["U_GUEST", "U_EXTERNAL", "U_OWNER", "U_NOLINK"]) {
      expect((await s.submit(submission("X", "v", "workspace"), who)).errors?.scope).toMatch(ORG_ADMINS);
    }
    expect((await s.submit(submission("X", "v", "session", { ch: "C1" }), "U_OWNER")).errors).toHaveProperty("scope");
    expect(await s.forSession(SESSION.key, "U_OWNER")).toEqual([]);
  });

  it("!secret lists names only; only an admin removes workspace secrets", async () => {
    await submit(submission("SHARED", "shared-value", "workspace"), "U_ADMIN");
    await submit(submission("MINE", "mine-value", "user"), "U_OWNER");
    await s.command({ kind: "list" }, inSession("U_OWNER"));
    const listing = String(last("chat.postEphemeral")!.text);
    expect(listing).toMatch(/SHARED/);
    expect(listing).toMatch(/MINE/);
    expect(listing).not.toMatch(/shared-value|mine-value/);

    for (const who of ["U_GUEST", "U_OWNER", "U_NOLINK"]) {
      await s.command({ kind: "rm", name: "SHARED" }, inSession(who));
      expect(String(last("chat.postEphemeral")!.text)).toMatch(ORG_ADMINS);
    }
    expect((await s.forSession(SESSION.key, "U_OWNER")).map((x) => x.name).sort()).toEqual(["MINE", "SHARED"]);
    await s.command({ kind: "rm", name: "SHARED" }, inSession("U_ADMIN"));
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

  it("from a session's thread the modal needs someone who can drive it; a failed lookup says try again (work 112)", async () => {
    drivers = ["U_OWNER"];
    expect(await s.submit(submission("TOKEN", "v", "user"), "U_MEMBER")).toEqual({ errors: { scope: driversCommandText("secret") } });
    expect((await s.submit(submission("TOKEN", "v", "user"), "U_OWNER")).errors).toBeUndefined();
    // Outside a session the person's own rules: an admin sets an organization secret, a member does not.
    expect((await s.submit(submission("ORG", "v", "workspace", { ch: "C1" }), "U_ADMIN")).errors).toBeUndefined();
    expect((await s.submit(submission("ORG", "v", "workspace", { ch: "C1" }), "U_MEMBER")).errors?.scope).toMatch(ORG_ADMINS);
    expect(await s.submit(submission("ORG", "v", "workspace", { ch: "C1" }), "U_DOWN")).toEqual({ errors: { scope: LOOKUP_FAILED_TEXT } });
  });
});


describe("computer session variables (!var)", () => {
  const say = async (text: string, ctx = inSession("U_OWNER")) => {
    await s.variableCommand(parseVariableCommand(text)!, ctx, text);
    return String(last("chat.postEphemeral")!.text);
  };

  it("sets a variable flagged for the runner, shows its value and pushes it; organization scope for admins only", async () => {
    for (const who of ["U_GUEST", "U_OWNER", "U_NOLINK"]) expect(await say("!var ORG_NAME acme-public-org org", inSession(who))).toMatch(ORG_ADMINS);
    expect(pushes).toEqual([]);
    expect(await say("!var ORG_NAME acme-public-org org", inSession("U_ADMIN"))).toMatch(/Set `ORG_NAME` = `acme-public-org`/);
    expect(pushes.at(-1)).toEqual({});
    expect(await s.forSession(SESSION.key, "U_OWNER")).toEqual([{ name: "ORG_NAME", value: "acme-public-org", scope: "workspace", variable: true }]);
    await say("!var REGION=eu-west-1");
    expect(pushes.at(-1)).toEqual({ key: SESSION.key });
    const listing = await say("!vars");
    expect(listing).toMatch(/REGION` = `eu-west-1` · this session/);
    expect(listing).toMatch(/ORG_NAME` = `acme-public-org` · the organization/);
    // Removing one is the admin's too.
    expect(await say("!var rm ORG_NAME org")).toMatch(ORG_ADMINS);
    expect(await say("!var rm ORG_NAME org", inSession("U_ADMIN"))).toMatch(/Removed `ORG_NAME`/);
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
    await s.confirmVariable("!var ORG_NAME x org", inSession("U_OWNER"), async (t) => void answers.push(t));
    expect(answers.at(-1)).toMatch(ORG_ADMINS);
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
  const ADMIN = { ...MEMBER, admin: true };
  const VALUE = "sk-live-do-not-show";

  it("sets a sealed session-only secret through the API without returning the value", async () => {
    const reply = await s.api(MEMBER, { op: "secrets.session.put", sessionId: "cs_test", name: "TOKEN", body: { value: "private-value", file: true } }, SESSION.key);
    expect(reply).toEqual({ status: 204 });
    expect(pushes.at(-1)).toEqual({ key: SESSION.key });
    expect(await s.forSession(SESSION.key, SESSION.ownerId)).toContainEqual({ name: "TOKEN", value: "private-value", file: true, scope: "session" });
    expect(await s.forSession("other-session", SESSION.ownerId)).toEqual([]);
    expect((await s.api(MEMBER, { op: "secrets.list" })).body).toEqual({ secrets: [], canManage: false });
    expect(JSON.stringify(calls)).not.toContain("private-value");
  });

  it("lists and deletes a session's own secrets: names and metadata only, other layers untouched", async () => {
    await s.api({ ...MEMBER, via: "opc" }, { op: "secrets.session.put", sessionId: "cs_test", name: "AWS_SECRET_ACCESS_KEY", body: { value: "dummy-session-value" } }, SESSION.key);
    await submit(submission("FROM_SLACK", "dummy-slack-value", "session"), "U_OWNER");
    await s.api(ADMIN, { op: "secrets.put", name: "ORG_ONLY", body: { value: "dummy-org-value" } });
    const listed = await s.api(MEMBER, { op: "secrets.session.list", sessionId: "cs_test" }, SESSION.key);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      secrets: [
        { name: "AWS_SECRET_ACCESS_KEY", scope: "session", sessionId: "cs_test", kind: "secret", file: false, effective: true, setBy: { id: MEMBER.member, name: "Owner", via: "opc", client: null }, updatedAt: expect.any(String) },
        { name: "FROM_SLACK", scope: "session", sessionId: "cs_test", kind: "secret", file: false, effective: true, setBy: { id: "U_OWNER", name: "U_OWNER", via: "slack", client: null }, updatedAt: expect.any(String) },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("dummy-");
    expect((await s.api(MEMBER, { op: "secrets.session.list", sessionId: "cs_other" }, "other-session")).body).toEqual({ secrets: [] });

    pushes = [];
    expect(await s.api(MEMBER, { op: "secrets.session.delete", sessionId: "cs_test", name: "AWS_SECRET_ACCESS_KEY" }, SESSION.key)).toEqual({ status: 204 });
    expect(pushes).toEqual([{ key: SESSION.key }]);
    expect((await s.forSession(SESSION.key, SESSION.ownerId)).map((x) => x.name).sort()).toEqual(["FROM_SLACK", "ORG_ONLY"]);
    expect((await s.api(MEMBER, { op: "secrets.session.delete", sessionId: "cs_test", name: "AWS_SECRET_ACCESS_KEY" }, SESSION.key)).error?.code).toBe("secret_not_found");
    // The organization's secret of a name is not the session's to delete.
    expect((await s.api(MEMBER, { op: "secrets.session.delete", sessionId: "cs_test", name: "ORG_ONLY" }, SESSION.key)).error?.code).toBe("secret_not_found");
    expect((await s.api(MEMBER, { op: "secrets.session.list", sessionId: "cs_test" })).error?.code).toBe("session_not_found");
  });

  it("a session secret is replaced or deleted only by its creator or an organization admin", async () => {
    const OTHER = { ...MEMBER, member: "usr_01jothermemberxxxxxxxxxxxx", userId: "user_2", name: "Other" };
    const ADMIN = { ...MEMBER, member: "usr_01jadminmemberxxxxxxxxxxxx", userId: "user_3", name: "Admin", admin: true };
    const put = (who: typeof MEMBER, name: string, value: string) => s.api(who, { op: "secrets.session.put", sessionId: "cs_test", name, body: { value } }, SESSION.key);
    const del = (who: typeof MEMBER, name: string) => s.api(who, { op: "secrets.session.delete", sessionId: "cs_test", name }, SESSION.key);

    // A new name is anyone's who may write to the session; its creator replaces and deletes it.
    expect(await put(MEMBER, "MINE", "dummy-1")).toEqual({ status: 204 });
    expect(await put(MEMBER, "MINE", "dummy-2")).toEqual({ status: 204 });
    expect(await put(OTHER, "THEIRS", "dummy-3")).toEqual({ status: 204 });

    // Someone else gets 403 not_secret_owner, naming the creator, and nothing changes.
    pushes = [];
    for (const reply of [await put(OTHER, "MINE", "dummy-4"), await del(OTHER, "MINE")]) {
      expect(reply).toEqual({ status: 403, error: { code: "forbidden", reason: "not_secret_owner", message: "Only the person who set MINE (Owner) or an organization admin can replace or delete it." } });
    }
    expect(pushes).toEqual([]);
    expect((await s.forSession(SESSION.key, SESSION.ownerId)).find((x) => x.name === "MINE")?.value).toBe("dummy-2");

    // An admin may; replacing keeps the creator, so the creator still may afterwards.
    expect(await put(ADMIN, "MINE", "dummy-5")).toEqual({ status: 204 });
    expect((await put(OTHER, "MINE", "dummy-6")).error?.reason).toBe("not_secret_owner");
    expect(await del(MEMBER, "MINE")).toEqual({ status: 204 });
    expect(await del(ADMIN, "THEIRS")).toEqual({ status: 204 });

    // Set in Slack: the Slack user's linked member is its creator; others are not.
    await submit(submission("FROM_SLACK", "dummy-slack", "session"), "U_OWNER");
    expect((await del(OTHER, "FROM_SLACK")).error?.reason).toBe("not_secret_owner");
    expect(await del(MEMBER, "FROM_SLACK")).toEqual({ status: 204 });
    await submit(submission("UNLINKED", "dummy-slack", "session"), "U_GUESTLESS");
    expect((await del(MEMBER, "UNLINKED")).error?.reason).toBe("not_secret_owner");
    expect(await del(ADMIN, "UNLINKED")).toEqual({ status: 204 });
  });

  it("in Slack too, a session secret is replaced or deleted only by its creator or an organization admin", async () => {
    const refusal = (name: string, by: string) => `Only the person who set ${name} (Name of ${by}) or an organization admin can replace or delete it.`;
    const rm = async (name: string, userId: string) => {
      await s.command({ kind: "rm", name, scope: "session" }, inSession(userId));
      return last("chat.postEphemeral")?.text;
    };
    const value = async (name: string) => (await s.forSession(SESSION.key, SESSION.ownerId)).find((x) => x.name === name)?.value;

    // The creator replaces (modal) and deletes (`!secret rm`).
    expect((await submit(submission("S1", "dummy-1", "session"), "U_OWNER")).errors).toBeUndefined();
    expect((await submit(submission("S1", "dummy-2", "session"), "U_OWNER")).errors).toBeUndefined();
    expect(await rm("S1", "U_OWNER")).toMatch(/^Removed `S1`/);

    // Another member who may instruct the session: refused on both paths, naming the creator; nothing changes.
    await submit(submission("S2", "dummy-3", "session"), "U_OWNER");
    pushes = [];
    expect(await s.submit(submission("S2", "dummy-4", "session"), "U_OTHER")).toEqual({ errors: { scope: refusal("S2", "U_OWNER") } });
    expect(await rm("S2", "U_OTHER")).toBe(refusal("S2", "U_OWNER"));
    expect(await value("S2")).toBe("dummy-3");
    expect(pushes).toEqual([]);

    // An admin may; the creator is kept, so others are still refused in the creator's name.
    expect((await submit(submission("S2", "dummy-5", "session"), "U_ADMIN")).errors).toBeUndefined();
    expect(await s.submit(submission("S2", "dummy-6", "session"), "U_OTHER")).toEqual({ errors: { scope: refusal("S2", "U_OWNER") } });
    expect(await rm("S2", "U_ADMIN")).toMatch(/^Removed `S2`/);

    // A Slack user who linked no member only adds new names: not even their own can be replaced or deleted.
    expect((await submit(submission("S3", "dummy-7", "session"), "U_NOLINK")).errors).toBeUndefined();
    expect(await s.submit(submission("S3", "dummy-8", "session"), "U_NOLINK")).toEqual({ errors: { scope: refusal("S3", "U_NOLINK") } });
    expect(await rm("S3", "U_NOLINK")).toBe(refusal("S3", "U_NOLINK"));
    expect(await value("S3")).toBe("dummy-7");

    // Set in Slack, it is the linked member's on the API too, with the same message for others.
    const api = (member: string, admin = false) =>
      s.api({ ...MEMBER, member, ...(admin ? { admin } : {}) }, { op: "secrets.session.delete", sessionId: "cs_test", name: "S3" }, SESSION.key);
    expect((await api(LINKS.U_OTHER!)).error?.message).toBe(refusal("S3", "U_NOLINK"));
    expect(await api(LINKS.U_ADMIN!, true)).toEqual({ status: 204 });

    // Organization secrets have their own rule: only an admin removes one, whoever set it.
    await submit(submission("ORG_S", "dummy-9", "workspace", { ch: "C1" }), "U_ADMIN");
    await s.command({ kind: "rm", name: "ORG_S", scope: "workspace" }, inSession("U_OTHER"));
    expect(last("chat.postEphemeral")?.text).toMatch(ORG_ADMINS);
    await s.command({ kind: "rm", name: "ORG_S", scope: "workspace" }, inSession("U_ADMIN"));
    expect(last("chat.postEphemeral")?.text).toMatch(/^Removed `ORG_S`/);
  });

  it("only an admin sets, replaces and deletes; values never come back; every session gets it", async () => {
    const created = await s.api(ADMIN, { op: "secrets.put", name: "EXECUTOR_API_KEY", body: { value: VALUE } });
    expect(created).toMatchObject({ status: 201, body: { secret: { name: "EXECUTOR_API_KEY", layer: "organization", kind: "secret", file: false, updatedBy: { member: MEMBER.member, name: "Owner" } } } });
    expect(pushes).toEqual([{}]);
    expect((await s.forSession(SESSION.key, SESSION.ownerId)).find((x) => x.name === "EXECUTOR_API_KEY")?.value).toBe(VALUE);

    const replaced = await s.api({ ...ADMIN, via: "opc" }, { op: "secrets.put", name: "EXECUTOR_API_KEY", body: { value: "sk-new" } });
    expect(replaced.status).toBe(200);
    const listed = await s.api(MEMBER, { op: "secrets.list" });
    expect(JSON.stringify(listed)).not.toContain("sk-");
    expect(listed.body).toMatchObject({ secrets: [{ name: "EXECUTOR_API_KEY", createdBy: { member: MEMBER.member } }], canManage: false });
    expect((await s.api(ADMIN, { op: "secrets.list" })).body).toMatchObject({ canManage: true });

    expect((await s.api(ADMIN, { op: "secrets.delete", name: "EXECUTOR_API_KEY" })).status).toBe(204);
    expect((await s.api(ADMIN, { op: "secrets.delete", name: "EXECUTOR_API_KEY" })).error?.code).toBe("secret_not_found");
    const events = (await s.api(MEMBER, { op: "secrets.events", name: "EXECUTOR_API_KEY" })).body as { events: Array<{ action: string; via: string }> };
    expect(events.events.map((e) => [e.action, e.via])).toEqual([["delete", "dashboard"], ["replace", "opc"], ["set", "dashboard"]]);
  });

  it("a member (or a caller whose role is unknown) cannot set, replace or delete one, whoever set it; nothing changes", async () => {
    await s.api(ADMIN, { op: "secrets.put", name: "SHARED", body: { value: "dummy-admin" } });
    pushes = [];
    const refusal = { status: 403, error: { code: "forbidden", reason: "admin_required", message: "Only an organization admin can set, replace or delete organization secrets." } };
    for (const who of [MEMBER, { ...MEMBER, admin: false }]) {
      expect(await s.api(who, { op: "secrets.put", name: "SHARED", body: { value: "dummy-member" } })).toEqual(refusal);
      expect(await s.api(who, { op: "secrets.put", name: "NEW_ONE", body: { value: "dummy-member", variable: true } })).toEqual(refusal);
      expect(await s.api(who, { op: "secrets.delete", name: "SHARED" })).toEqual(refusal);
    }
    expect(pushes).toEqual([]);
    expect(await s.forSession(SESSION.key, SESSION.ownerId)).toEqual([{ name: "SHARED", value: "dummy-admin", scope: "workspace" }]);
    const events = (await s.api(MEMBER, { op: "secrets.events", name: "SHARED" })).body as { events: unknown[] };
    expect(events.events).toHaveLength(1);
  });

  it("the organization's history covers every name, newest first, from every surface, without values", async () => {
    await s.api(ADMIN, { op: "secrets.put", name: "A_KEY", body: { value: "dummy-a" } });
    await submit(submission("B_KEY", "dummy-b", "workspace", { ch: "C1" }), "U_ADMIN");
    await s.api({ ...ADMIN, via: "opc" }, { op: "secrets.delete", name: "A_KEY" });
    // Narrower layers are not the organization's.
    await submit(submission("C_KEY", "dummy-c", "session"), "U_OWNER");
    const reply = await s.api(MEMBER, { op: "secrets.history" });
    expect(reply.status).toBe(200);
    const { events } = reply.body as { events: Array<Record<string, unknown>> };
    expect(events.map((e) => [e.name, e.action, e.via])).toEqual([["A_KEY", "delete", "opc"], ["B_KEY", "set", "slack"], ["A_KEY", "set", "dashboard"]]);
    expect(events[1]).toMatchObject({ kind: "secret", actor: { slackUserId: "U_ADMIN" } });
    expect(JSON.stringify(reply)).not.toContain("dummy-");
  });

  it("lists variables with their values, counts narrower copies that win, and records Slack changes too", async () => {
    await s.api(ADMIN, { op: "secrets.put", name: "OPENAI_BASE_URL", body: { value: "https://proxy.example", variable: true } });
    await submit(submission("OPENAI_KEY", "x", "workspace"), "U_ADMIN");
    await submit(submission("OPENAI_KEY", "y", "session"), "U_OWNER");
    await submit(submission("OPENAI_KEY", "z", "user"), "U_OWNER");
    const { secrets } = (await s.api(MEMBER, { op: "secrets.list" })).body as { secrets: Array<Record<string, unknown>> };
    expect(secrets).toEqual([
      expect.objectContaining({ name: "OPENAI_BASE_URL", kind: "variable", value: "https://proxy.example" }),
      expect.objectContaining({ name: "OPENAI_KEY", kind: "secret", updatedBy: { slackUserId: "U_ADMIN" }, overriddenIn: { threads: 1, people: 1 } }),
    ]);
    expect(secrets[1]).not.toHaveProperty("value");
    const events = (await s.api(MEMBER, { op: "secrets.events", name: "OPENAI_KEY" })).body as { events: Array<{ via: string }> };
    expect(events.events).toEqual([expect.objectContaining({ action: "set", via: "slack", actor: { slackUserId: "U_ADMIN" } })]);
  });

  it("refuses reserved names, base URLs as secrets, bad bodies, and a full layer", async () => {
    const put = (name: string, body: unknown) => s.api(ADMIN, { op: "secrets.put", name, body });
    expect((await put("NODE_OPTIONS", { value: "x" })).error?.code).toBe("invalid_name");
    expect((await put("PIP_INDEX_URL", { value: "x", variable: true })).error?.code).toBe("invalid_name");
    expect((await put("OPENAI_BASE_URL", { value: "x" })).error?.code).toBe("invalid_name");
    expect((await put("A", {})).error).toMatchObject({ code: "invalid_request", field: "value" });
    expect((await put("A", { value: "x", file: true, variable: true })).error?.code).toBe("invalid_request");
    expect((await put("A", { value: "x".repeat(64 * 1024 + 1) })).status).toBe(413);
    for (let i = 0; i < 200; i++) await s.api({ ...ADMIN, member: `usr_${i}` }, { op: "secrets.put", name: `K${i}`, body: { value: "v" } });
    expect((await put("ONE_TOO_MANY", { value: "v" })).error?.code).toBe("limit_reached");
  });

  it("limits one caller to 30 changes a minute", async () => {
    for (let i = 0; i < 30; i++) expect((await s.api(ADMIN, { op: "secrets.put", name: `K${i}`, body: { value: "v" } })).status).toBe(201);
    expect((await s.api(ADMIN, { op: "secrets.put", name: "K30", body: { value: "v" } })).status).toBe(429);
  });
});
