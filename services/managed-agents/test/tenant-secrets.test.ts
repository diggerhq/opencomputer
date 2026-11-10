import { env, SELF, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDeployment, InitializeSessionResult } from "../src/protocol.js";

/**
 * Per-installation credentials.
 *
 * One deployment answers every workspace that installed the app. A credential
 * that belongs to the customer behind a workspace — their billing account,
 * their CRM — must therefore be chosen by which installation the message came
 * through, not by which agent is running. These cover the part that makes that
 * safe: that the value follows the session's installation, and that when there
 * isn't one nothing is substituted.
 */

const APP = "app_tenant_secrets";
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

beforeEach(async () => {
  await env.SERVERLESS_AGENTS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS session_creations (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      countable INTEGER NOT NULL DEFAULT 1,
      exclusion_reason TEXT,
      outcome_at TEXT
    )`,
  ).run();
  await env.SERVERLESS_AGENTS_DB.prepare("DELETE FROM session_creations").run();
});

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

/** A project, an agent, and a deployment whose one header is tenant-scoped. */
async function deployTenantScopedAgent() {
  const project = await json<{ id: string; agents: Array<{ id: string }> }>(
    await SELF.fetch("https://managedagents.test/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: "Tenant secrets", slug: "tenant-secrets" }),
    }),
  );
  const agentId = project.agents[0]!.id;
  await json<AgentDeployment>(
    await SELF.fetch("https://managedagents.test/v1/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId,
        alias: "development",
        connections: ["billing-api", "billing-as-user"],
        httpConnections: [
          {
            id: "billing-as-user",
            origin: "https://billing.example.com",
            methods: ["GET"],
            pathPrefix: "/v1/",
            headers: {
              Authorization: {
                kind: "secret",
                name: "BILLING_KEY",
                scope: "user",
                prefix: "Bearer ",
              },
            },
          },
          {
            id: "billing-api",
            origin: "https://billing.example.com",
            methods: ["GET"],
            pathPrefix: "/v1/",
            headers: {
              Authorization: {
                kind: "secret",
                name: "BILLING_KEY",
                scope: "tenant",
                prefix: "Bearer ",
              },
            },
          },
        ],
        artifact: {
          bucket: "managed-agent-artifacts",
          key: "agents/tenant-secrets/digest.json",
          digest: "f".repeat(64),
          size: 512,
        },
        imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
        imageVersion: "1.0",
      }),
    }),
  );
  return { projectId: project.id, agentId };
}

/** Two installations of one app, standing in for two customers. */
async function installTwoWorkspaces(agentId: string) {
  const account = env.ACCOUNTS.getByName("local");
  await account.createChannelApp({
    id: APP,
    provider: "slack",
    externalAppId: "A-TENANT",
    agentId,
    alias: "development",
    signingSecret: SIGNING_SECRET,
    label: "Tenant secrets",
  });
  const acme = await account.upsertAppInstallation({
    appId: APP,
    provider: "slack",
    agentId,
    alias: "development",
    channelId: "slack",
    workspaceId: "T-ACME",
    botToken: "xoxb-acme",
    signingSecret: SIGNING_SECRET,
  });
  const globex = await account.upsertAppInstallation({
    appId: APP,
    provider: "slack",
    agentId,
    alias: "development",
    channelId: "slack",
    workspaceId: "T-GLOBEX",
    botToken: "xoxb-globex",
    signingSecret: SIGNING_SECRET,
  });
  return { account, acme, globex };
}

async function sessionActingFor(
  agentId: string,
  connectionId: string,
  externalUserId: string,
) {
  const session = await sessionBoundTo(agentId, connectionId);
  await env.SESSIONS.getByName(session.session.id).setActingUser(externalUserId);
  return session;
}

async function putUserSecret(
  connectionId: string,
  externalUserId: string,
  value: string,
) {
  return SELF.fetch(
    `https://managedagents.test/v1/channels/slack/apps/${APP}/installations/${connectionId}/users/${externalUserId}/secrets/BILLING_KEY`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value,
        allowedOrigins: ["https://billing.example.com"],
      }),
    },
  );
}

async function sessionBoundTo(agentId: string, connectionId?: string) {
  const session = await json<InitializeSessionResult>(
    await SELF.fetch("https://managedagents.test/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${agentId}@development` }),
    }),
  );
  if (connectionId) {
    await env.SESSIONS.getByName(session.session.id).bindChannelConnection(
      connectionId,
    );
  }
  return session;
}

function callBilling(
  session: InitializeSessionResult,
  connection = "billing-api",
) {
  return SELF.fetch(
    `https://managedagents.test/v1/sessions/${session.session.id}/egress/${connection}/fetch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "GET", path: "/v1/customers", headers: {} }),
    },
  );
}

describe("per-installation secrets", () => {
  it("sends each installation's own credential", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme, globex } = await installTwoWorkspaces(agentId);
    for (const [connectionId, value] of [
      [acme.id, "acme-key"],
      [globex.id, "globex-key"],
    ] as const) {
      await json(
        await SELF.fetch(
          `https://managedagents.test/v1/channels/slack/apps/${APP}/installations/${connectionId}/secrets/BILLING_KEY`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              value,
              allowedOrigins: ["https://billing.example.com"],
            }),
          },
        ),
      );
    }

    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ ok: true });
      }),
    );

    expect((await callBilling(await sessionBoundTo(agentId, acme.id))).status).toBe(200);
    expect((await callBilling(await sessionBoundTo(agentId, globex.id))).status).toBe(200);
    expect(seen).toEqual(["Bearer acme-key", "Bearer globex-key"]);
  });

  it("refuses when the session belongs to no installation", async () => {
    const { agentId } = await deployTenantScopedAgent();
    await installTwoWorkspaces(agentId);
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);

    const response = await callBilling(await sessionBoundTo(agentId));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "tenant_secret_unbound" }),
      }),
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  /**
   * The leak this scope exists to stop. A project secret of the same name is
   * present and would resolve for any session; a tenant-scoped header must
   * never reach for it, or one customer's agent sends another customer's key.
   */
  it("never falls back to the project secret", async () => {
    const { projectId, agentId } = await deployTenantScopedAgent();
    const { acme } = await installTwoWorkspaces(agentId);
    await json(
      await SELF.fetch(
        `https://managedagents.test/v1/projects/${projectId}/secrets/BILLING_KEY`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value: "the-operators-own-key",
            environment: "development",
            allowedOrigins: ["https://billing.example.com"],
          }),
        },
      ),
    );

    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);

    // Bound to a real installation, which simply has no secret of its own.
    const response = await callBilling(await sessionBoundTo(agentId, acme.id));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "tenant_secret_unavailable" }),
      }),
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps a session bound to the first installation that claimed it", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme, globex } = await installTwoWorkspaces(agentId);
    const session = await sessionBoundTo(agentId, acme.id);
    const stub = env.SESSIONS.getByName(session.session.id);
    await expect(stub.bindChannelConnection(globex.id)).resolves.toBe(acme.id);
    await expect(stub.channelConnectionId()).resolves.toBe(acme.id);
  });

  it("will not write a secret onto an installation of another app", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { account, acme } = await installTwoWorkspaces(agentId);
    await account.createChannelApp({
      id: "app_other",
      provider: "slack",
      externalAppId: "A-OTHER",
      agentId,
      alias: "development",
      signingSecret: SIGNING_SECRET,
      label: "Other",
    });
    const response = await SELF.fetch(
      `https://managedagents.test/v1/channels/slack/apps/app_other/installations/${acme.id}/secrets/BILLING_KEY`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: "stolen",
          allowedOrigins: ["https://billing.example.com"],
        }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("lists names without ever returning a value", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme } = await installTwoWorkspaces(agentId);
    const value = "a-value-that-must-not-come-back";
    await json(
      await SELF.fetch(
        `https://managedagents.test/v1/channels/slack/apps/${APP}/installations/${acme.id}/secrets/BILLING_KEY`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value,
            allowedOrigins: ["https://billing.example.com"],
          }),
        },
      ),
    );
    const listed = await SELF.fetch(
      `https://managedagents.test/v1/channels/slack/apps/${APP}/installations/${acme.id}/secrets`,
    );
    const body = await listed.text();
    expect(listed.status).toBe(200);
    expect(body).toContain("BILLING_KEY");
    expect(body).not.toContain(value);
  });

  it("removes a credential when an installation is torn down", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme } = await installTwoWorkspaces(agentId);
    const path = `https://managedagents.test/v1/channels/slack/apps/${APP}/installations/${acme.id}/secrets/BILLING_KEY`;
    await json(
      await SELF.fetch(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: "temporary",
          allowedOrigins: ["https://billing.example.com"],
        }),
      }),
    );
    expect((await SELF.fetch(path, { method: "DELETE" })).status).toBe(204);
    expect((await SELF.fetch(path, { method: "DELETE" })).status).toBe(404);

    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);
    expect((await callBilling(await sessionBoundTo(agentId, acme.id))).status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
  });

  /**
   * Per-person credentials. The installation says what a workspace may do;
   * this says what a particular person may do, so the upstream applies its own
   * permissions rather than everyone sharing one account.
   */
  it("sends each person's own credential", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme } = await installTwoWorkspaces(agentId);
    await json(await putUserSecret(acme.id, "U-DANA", "dana-key"));
    await json(await putUserSecret(acme.id, "U-SAM", "sam-key"));

    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ ok: true });
      }),
    );

    for (const user of ["U-DANA", "U-SAM"]) {
      const session = await sessionActingFor(agentId, acme.id, user);
      expect((await callBilling(session, "billing-as-user")).status).toBe(200);
    }
    expect(seen).toEqual(["Bearer dana-key", "Bearer sam-key"]);
  });

  it("refuses a person who has not connected their account", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme } = await installTwoWorkspaces(agentId);
    // The installation has a credential; the person does not. Falling back to
    // it would let anyone in the workspace act with the installer's authority.
    await json(
      await SELF.fetch(
        `https://managedagents.test/v1/channels/slack/apps/${APP}/installations/${acme.id}/secrets/BILLING_KEY`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value: "the-installers-key",
            allowedOrigins: ["https://billing.example.com"],
          }),
        },
      ),
    );
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);

    const session = await sessionActingFor(agentId, acme.id, "U-STRANGER");
    const response = await callBilling(session, "billing-as-user");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "user_secret_unavailable" }),
      }),
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses when the session is acting for nobody", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme } = await installTwoWorkspaces(agentId);
    await json(await putUserSecret(acme.id, "U-DANA", "dana-key"));
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);

    const response = await callBilling(
      await sessionBoundTo(agentId, acme.id),
      "billing-as-user",
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "user_secret_unbound" }),
      }),
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps one person's credential out of another's reach", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme, globex } = await installTwoWorkspaces(agentId);
    // Same person id in two workspaces is two different people.
    await json(await putUserSecret(acme.id, "U-SAME", "acme-sams-key"));
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);

    const response = await callBilling(
      await sessionActingFor(agentId, globex.id, "U-SAME"),
      "billing-as-user",
    );
    expect(response.status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("lists a person's credentials without their values", async () => {
    const { agentId } = await deployTenantScopedAgent();
    const { acme } = await installTwoWorkspaces(agentId);
    const value = "dana-value-that-must-not-come-back";
    await json(await putUserSecret(acme.id, "U-DANA", value));
    const listed = await SELF.fetch(
      `https://managedagents.test/v1/channels/slack/apps/${APP}/installations/${acme.id}/users/U-DANA/secrets`,
    );
    const body = await listed.text();
    expect(listed.status).toBe(200);
    expect(body).toContain("U-DANA");
    expect(body).not.toContain(value);
  });
});
