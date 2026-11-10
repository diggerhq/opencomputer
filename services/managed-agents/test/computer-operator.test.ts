import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";

/**
 * Work 092, step 4: an operator reads an organization's computer and wakes
 * it, behind the operator secret, without the customer messaging it.
 */

const ORIGIN = "https://managedagents.test";
const SECRET = "test-session-index-admin-secret";
const ORG = "org_operator";

type Namespace = DurableObjectNamespace<ComputerDurableObject>;
const computer = (name: string) => (env as unknown as { COMPUTERS: Namespace }).COMPUTERS.getByName(name);
const org = () => computer(ORG);
const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T, name = ORG) =>
  runInDurableObject(computer(name), fn as never) as Promise<T>;
const row = () => inside((instance) => instance.lifecycle.row() as { state: string } | undefined);

async function operator(action: "status" | "wake", account = ORG, secret: string | null = SECRET) {
  const response = await SELF.fetch(`${ORIGIN}/internal/computer/${action}?account_id=${account}`, {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function settle(until: string) {
  for (let i = 0; i < 30 && (await row())?.state !== until; i += 1) {
    await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
    await runDurableObjectAlarm(org());
  }
  expect((await row())?.state).toBe(until);
}

describe("operator computer routes", () => {
  it("refuses without the operator secret", async () => {
    expect((await operator("status", ORG, null)).status).toBe(401);
    expect((await operator("wake", ORG, "wrong")).status).toBe(401);
  });

  it("answers 404 for an organization without a computer, and never creates one", async () => {
    expect((await operator("status", "org_none")).status).toBe(404);
    expect((await operator("wake", "org_none")).status).toBe(404);
    expect(await inside((instance) => instance.lifecycle.row(), "org_none")).toBeUndefined();
  });

  it("shows a trial computer, wakes it once parked, and leaves a ready one as it is", async () => {
    const trialEndsAt = Math.floor(Date.now() / 1000) + 2 * 86_400;
    await inside((instance) => {
      instance.env.OPENCOMPUTER_BILLING = {
        checkAdmission: async () => ({ allowed: true, isHalted: false, paid: false, modelAccess: null, trialEndsAt }),
      };
    });
    try {
      expect(await org().ensureComputer(ORG)).toMatchObject({ status: 202 });
      await settle("ready");

      const ready = await operator("status");
      expect(ready.status).toBe(200);
      expect(ready.body).toMatchObject({
        accountId: ORG,
        state: "ready",
        plan: "free",
        trialEndsAt: new Date(trialEndsAt * 1000).toISOString(),
        haltedAt: null,
      });

      // Ready: the wake changes nothing.
      const again = await operator("wake");
      expect(again.status).toBe(200);
      expect(again.body.state).toBe("ready");

      expect(await inside((instance) => instance.lifecycle.park() as Promise<boolean>)).toBe(true);
      await settle("parked");
      expect((await operator("status")).body.state).toBe("parked");

      // Long idle: the wake starts it and opens a fresh idle window.
      await inside((instance) => instance.put("lastActivityAt", String(Date.now() - 86_400_000)));
      const woken = await operator("wake");
      expect(woken.status).toBe(202);
      expect(woken.body.state).toBe("waking");
      expect(Date.parse(woken.body.lastActivityAt)).toBeGreaterThan(Date.now() - 60_000);
      await settle("ready");
    } finally {
      await inside((instance) => {
        delete instance.env.OPENCOMPUTER_BILLING;
      });
    }
  });
});
