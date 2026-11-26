import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "./commands.js";

// `connection revoke` names one grant to the computer; the connection's others stay.

const CONNECTION = { id: "conn_1", provider: "linear", label: "work", scopes: [] };
const grant = (scope: string, subject: string) => ({
  service: "linear",
  provider: "linear",
  label: "work",
  connectionId: "conn_1",
  connection: CONNECTION,
  scope,
  subject,
  grantedBy: "U1",
  createdAt: "",
  updatedAt: "",
});

async function withIsolatedConfig(fn: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oc-revoke-"));
  const previous = { config: process.env.OPENCOMPUTER_CONFIG, key: process.env.OPENCOMPUTER_API_KEY, url: process.env.OPENCOMPUTER_API_URL };
  process.env.OPENCOMPUTER_CONFIG = join(directory, "config.json");
  delete process.env.OPENCOMPUTER_API_KEY;
  delete process.env.OPENCOMPUTER_API_URL;
  try {
    await fn();
  } finally {
    for (const [name, value] of Object.entries({ OPENCOMPUTER_CONFIG: previous.config, OPENCOMPUTER_API_KEY: previous.key, OPENCOMPUTER_API_URL: previous.url })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function serve(context: test.TestContext, grants: ReturnType<typeof grant>[]) {
  const deletes: unknown[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/api/managed-agents/computer/service-connections" && request.method === "DELETE") {
      deletes.push(await request.json());
      return new Response(null, { status: 204 });
    }
    if (path === "/api/managed-agents/computer/service-connections") return Response.json({ attachments: grants });
    if (path.endsWith("/service-connections") || path.endsWith("/connections")) return Response.json({ connections: [CONNECTION], data: [CONNECTION] });
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 });
  });
  context.mock.method(process.stdout, "write", () => true);
  return deletes;
}

const revoke = (...args: string[]) => runCommand("connection", ["revoke", "work", ...args], { json: false, apiKey: "osb_test" });

test("revoke sends the one grant a flag names", async (context) => {
  await withIsolatedConfig(async () => {
    const deletes = serve(context, [grant("everyone", ""), grant("session", "T1:C1:1.1"), grant("user", "U2")]);
    await revoke("--session", "T1:C1:1.1");
    await revoke("--user", "U2");
    await revoke("--everyone");
    assert.deepEqual(deletes, [
      { connectionId: "conn_1", scope: "session", subject: "T1:C1:1.1" },
      { connectionId: "conn_1", scope: "user", subject: "U2" },
      { connectionId: "conn_1", scope: "everyone" },
    ]);
  });
});

test("revoke without a flag revokes the only grant, and refuses to guess between several", async (context) => {
  await withIsolatedConfig(async () => {
    const one = serve(context, [grant("session", "T1:C1:1.1")]);
    await revoke();
    assert.deepEqual(one, [{ connectionId: "conn_1", scope: "session", subject: "T1:C1:1.1" }]);
  });
  context.mock.restoreAll();
  await withIsolatedConfig(async () => {
    const several = serve(context, [grant("everyone", ""), grant("user", "U2")]);
    await assert.rejects(revoke(), /has 2 grants; choose the one to revoke:[\s\S]*--everyone[\s\S]*--user U2/);
    await assert.rejects(revoke("--everyone", "--user", "U2"), /Choose one grant to revoke/);
    assert.deepEqual(several, []);
  });
  context.mock.restoreAll();
  await withIsolatedConfig(async () => {
    const none = serve(context, []);
    await assert.rejects(revoke(), /is not granted to the computer/);
    assert.deepEqual(none, []);
  });
});
