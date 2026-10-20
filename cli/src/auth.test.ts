import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listOrgs, login, switchOrg } from "./auth.js";

const apiUrl = "https://oc.test";
const personal = { id: "org-personal", name: "Personal" };
const team = { id: "org-team", name: "Clawputer" };

interface Call {
  method: string;
  path: string;
  apiKey: string | null;
  body?: unknown;
}

type Handler = (call: Call) => Response;

async function withLogin(
  handler: Handler,
  run: (calls: Call[], configFile: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oc-auth-test-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    apiUrl,
    apiKey: "osb_old",
    login: { credentialId: "key-old", keyPrefix: "osb_old", name: "opencomputer CLI on test" },
  }));
  const previousConfig = process.env.OPENCOMPUTER_CONFIG;
  const previousKey = process.env.OPENCOMPUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENCOMPUTER_CONFIG = configFile;
  delete process.env.OPENCOMPUTER_API_KEY;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      apiKey: headers.get("x-api-key"),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  try {
    await run(calls, configFile);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousConfig === undefined) delete process.env.OPENCOMPUTER_CONFIG;
    else process.env.OPENCOMPUTER_CONFIG = previousConfig;
    if (previousKey !== undefined) process.env.OPENCOMPUTER_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
}

function whoami(call: Call): Response {
  const org = call.apiKey === "osb_new" ? team : personal;
  return Response.json({
    org_id: org.id,
    org_name: org.name,
    user_id: "user-1",
    email: "mo@example.com",
  });
}

const switchingAPI: Handler = (call) => {
  if (call.path === "/api/whoami") return whoami(call);
  if (call.path === "/auth/cli/orgs") {
    return Response.json({ org_id: personal.id, orgs: [personal, team] });
  }
  if (call.path === "/auth/cli/switch") {
    const wanted = (call.body as { org: string }).org;
    if (wanted.toLowerCase() !== "clawputer" && wanted !== team.id) {
      return Response.json({ error: "org_not_found", orgs: [personal, team] }, { status: 404 });
    }
    return Response.json({
      status: "switched",
      credential: { id: "key-new", key: "osb_new", key_prefix: "osb_new", name: "opencomputer CLI on test" },
      org: team,
      orgs: [personal, team],
      previous_credential_revoked: true,
    });
  }
  return new Response(null, { status: 404 });
};

test("org switch trades the saved login for one in the named org", async () => {
  await withLogin(switchingAPI, async (calls, configFile) => {
    const identity = await switchOrg({ apiUrl }, "clawputer");
    assert.equal(identity.org_id, team.id);
    assert.deepEqual(identity.orgs, [personal, team]);
    const swap = calls.find((call) => call.path === "/auth/cli/switch");
    assert.equal(swap?.apiKey, "osb_old");
    assert.deepEqual(swap?.body, { org: "clawputer" });
    const saved = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(saved.apiKey, "osb_new");
    assert.equal(saved.login.credentialId, "key-new");
  });
});

test("org switch names the user's orgs when none matches", async () => {
  await withLogin(switchingAPI, async (_calls, configFile) => {
    await assert.rejects(
      switchOrg({ apiUrl }, "Acme"),
      /not a member of an organization named or with id "Acme"[\s\S]*Clawputer {2}\(org-team\)/,
    );
    const saved = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(saved.apiKey, "osb_old");
  });
});

test("login --org moves an existing login without a browser round trip", async () => {
  await withLogin(switchingAPI, async (calls) => {
    const identity = await login({ apiUrl }, { noBrowser: true, force: false, org: team.id });
    assert.equal(identity.org_id, team.id);
    assert.equal(calls.some((call) => call.path === "/auth/cli/device"), false);
  });
});

test("a login from before org switching is told to log in again", async () => {
  const legacy: Handler = (call) =>
    call.path === "/api/whoami"
      ? whoami(call)
      : Response.json({ error: "cli_login_required" }, { status: 403 });
  await withLogin(legacy, async () => {
    await assert.rejects(
      switchOrg({ apiUrl }, "Clawputer"),
      /opencomputer login --force --org "Clawputer"/,
    );
    await assert.rejects(listOrgs({ apiUrl }), /opencomputer login --force/);
  });
});
