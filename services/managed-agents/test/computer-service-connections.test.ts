// Work 080 step 1: grants of account-owned connections to the organization's computer.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AccountDurableObject } from "../src/edge/account-do.js";
import type { ComputerServiceAttachment } from "../src/protocol.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { routeComputerServiceConnections } from "../src/edge/computer-service-connections.js";

const PATH = "https://managedagents.test/v1/computer/service-connections";

function account() {
  return env.ACCOUNTS.getByName("local");
}

/** Inside the object, so a thrown error is the method's, not an RPC rejection. */
function inAccount(fn: (instance: AccountDurableObject) => void) {
  return runInDurableObject(account(), (instance: AccountDurableObject) => fn(instance));
}

async function linear(id: string, ownerUserId: string, label = "default") {
  await account().upsertManagedToolConnection({
    id,
    provider: "linear",
    label,
    ownerUserId,
    externalAccountId: `ca_${id}`,
    scopes: ["read", "issues:create"],
  });
}

function person(userId: string, role?: string): RequestIdentity {
  return { kind: "user", userId, accountId: "local", ...(role ? { role } : {}) };
}

function call(identity: RequestIdentity, method: string, body?: unknown) {
  const request = new Request(PATH, {
    method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return routeComputerServiceConnections(request, env, identity) as Promise<Response>;
}

describe("computer service attachments", () => {
  it("keeps one grant per service, label and audience, and lists them all", async () => {
    await linear("grant-a", "alice");
    await linear("grant-b", "bob");
    const a = account();
    await a.grantComputerServiceConnection({ connectionId: "grant-a", scope: "everyone", subject: "ignored", grantedBy: "alice" });
    await a.grantComputerServiceConnection({ connectionId: "grant-a", scope: "user", subject: "U_ALICE", grantedBy: "U_ALICE" });
    await a.grantComputerServiceConnection({ connectionId: "grant-a", scope: "session", subject: "T1:C1:1.1", grantedBy: "U_ALICE" });
    // The same audience again: Bob's connection replaces Alice's behind the thread's grant.
    await a.grantComputerServiceConnection({ connectionId: "grant-b", scope: "session", subject: "T1:C1:1.1", grantedBy: "U_BOB" });
    const listed = await a.listComputerServiceAttachments("linear");
    expect(listed.map((g: ComputerServiceAttachment) => [g.scope, g.subject, g.connectionId, g.grantedBy])).toEqual([
      ["everyone", "", "grant-a", "alice"],
      ["session", "T1:C1:1.1", "grant-b", "U_BOB"],
      ["user", "U_ALICE", "grant-a", "U_ALICE"],
    ]);
    await inAccount((instance) =>
      expect(() =>
        instance.grantComputerServiceConnection({ connectionId: "grant-a", scope: "user", subject: "", grantedBy: "alice" }),
      ).toThrow(/subject/),
    );

    expect(await a.revokeComputerServiceConnection({ connectionId: "grant-a", scope: "user" })).toBe(1);
    expect(await a.revokeComputerServiceConnection({ connectionId: "grant-a" })).toBe(1);
    expect((await a.listComputerServiceAttachments()).map((g: ComputerServiceAttachment) => g.connectionId)).toEqual(["grant-b"]);

    // Deleting the connection takes its grants with it.
    await a.removeConnection("grant-b");
    expect(await a.listComputerServiceAttachments()).toEqual([]);
  });

  it("grants only connected managed OAuth connections", async () => {
    await account().upsertManagedToolConnection({
      id: "grant-pending",
      provider: "linear",
      label: "default",
      ownerUserId: "alice",
      scopes: ["read"],
      status: "pending",
    });
    await inAccount((instance) =>
      expect(() =>
        instance.grantComputerServiceConnection({ connectionId: "grant-pending", scope: "everyone", subject: "", grantedBy: "alice" }),
      ).toThrow(/connected tool connection/),
    );
  });

  it("from Slack lists only the owner's grantable connections and grants only those, never to everyone", async () => {
    await linear("slack-mine", "carol", "work");
    await linear("slack-theirs", "dave");
    const a = account();
    expect(await a.grantableComputerConnections("carol", "linear")).toEqual([{ id: "slack-mine", label: "work" }]);
    expect(await a.grantableComputerConnections("carol", "gmail")).toEqual([]);
    await a.grantOwnComputerServiceConnection({ connectionId: "slack-mine", ownerUserId: "carol", scope: "session", subject: "T1:C9:9.9", grantedBy: "U_CAROL" });
    expect((await a.listComputerServiceAttachments("linear")).find((g: ComputerServiceAttachment) => g.subject === "T1:C9:9.9")?.connectionId).toBe("slack-mine");
    await inAccount((instance) => {
      expect(() =>
        instance.grantOwnComputerServiceConnection({ connectionId: "slack-theirs", ownerUserId: "carol", scope: "user", subject: "U_CAROL", grantedBy: "U_CAROL" }),
      ).toThrow(/not found/);
      expect(() =>
        instance.grantOwnComputerServiceConnection({ connectionId: "slack-mine", ownerUserId: "carol", scope: "everyone" as "user", subject: "", grantedBy: "U_CAROL" }),
      ).toThrow(/dashboard/);
    });
    await a.revokeComputerServiceConnection({ connectionId: "slack-mine" });
  });

  it("lets only an admin grant their own connection to everyone, and its owner or an admin revoke", async () => {
    await linear("route-alice", "alice");
    await linear("route-bob", "bob", "bob");

    expect((await call(person("alice"), "POST", { connectionId: "route-alice" })).status).toBe(403);
    // Another person's connection is not found, even for an admin.
    expect((await call(person("alice", "admin"), "POST", { connectionId: "route-bob" })).status).toBe(404);
    const granted = await call(person("alice", "admin"), "POST", { connectionId: "route-alice" });
    expect(granted.status).toBe(201);
    const body = (await granted.json()) as Record<string, unknown> & { connection: object };
    expect(body).toMatchObject({ service: "linear", scope: "everyone", subject: "", grantedBy: "alice" });
    expect(body.connection).not.toHaveProperty("ownerUserId");
    expect(body.connection).not.toHaveProperty("externalAccountId");

    // Thread and personal grants come from Slack; the dashboard lists and revokes them too.
    await account().grantComputerServiceConnection({ connectionId: "route-bob", scope: "user", subject: "U_BOB", grantedBy: "U_BOB" });
    const listed = (await (await call(person("carol"), "GET")).json()) as { attachments: Array<{ connectionId: string }> };
    expect(listed.attachments.map((g) => g.connectionId).sort()).toEqual(["route-alice", "route-bob"]);

    expect((await call(person("carol"), "DELETE", { connectionId: "route-bob" })).status).toBe(404);
    expect((await call(person("carol"), "DELETE", { connectionId: "route-alice", scope: "nobody" })).status).toBe(400);
    expect((await call(person("bob"), "DELETE", { connectionId: "route-bob", scope: "user", subject: "U_BOB" })).status).toBe(204);
    expect((await call(person("carol", "admin"), "DELETE", { connectionId: "route-alice" })).status).toBe(204);
    expect((await call(person("carol", "admin"), "DELETE", { connectionId: "route-alice" })).status).toBe(404);
  });

  it("refuses the computer, project keys and other routes", async () => {
    await linear("route-computer", "alice");
    const computer: RequestIdentity = { ...person("computer", "admin"), principal: "computer", sessionKey: "T1:C1:1.1" };
    expect((await call(computer, "GET")).status).toBe(403);
    expect((await call(computer, "POST", { connectionId: "route-computer" })).status).toBe(403);
    expect((await call({ ...person("alice", "admin"), projectId: "p1" }, "GET")).status).toBe(403);
    const other = new Request("https://managedagents.test/v1/computer/sessions");
    expect(await routeComputerServiceConnections(other, env, person("alice"))).toBeNull();
  });

  it("is mounted on the edge", async () => {
    const listed = await SELF.fetch(PATH);
    expect(listed.status).toBe(200);
    // The local development caller is not an admin.
    const granted = await SELF.fetch(PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "anything" }),
    });
    expect(granted.status).toBe(403);
  });
});
