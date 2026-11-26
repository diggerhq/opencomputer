import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";

/** What is left of the queue tests once Slack ingress is the Slack actor's: the size reconciliation and the unsealed credentials. */

const ORIGIN = "https://managedagents.test";
const KEY = "test-computer-host-token-key";

type Stub = DurableObjectStub<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: DurableObjectNamespace<ComputerDurableObject> }).COMPUTERS;
const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await sleep(20);
  }
  throw new Error(`${what} not reached`);
}

/** A linked organization with a connected host; every frame the host gets is collected. */
async function organization(org: string, team: string): Promise<{ stub: Stub; frames: any[]; socket: WebSocket }> {
  await computers().getByName(`computer-slack-team:${team}`).claimTeam(team, org);
  const stub = computers().getByName(org);
  await stub.linkSlack(org, { teamId: team, teamName: "Queue", botUserId: "UBOTQ", botToken: "xoxb-queue-token" });
  // The owners are known people: no name lookup on the path in these tests.
  await inside(stub, (_instance, state) => {
    for (const id of ["U1", "U2"]) {
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES (?, ?, ?, ?, ?)",
        id,
        `slack-${id.toLowerCase()}`,
        `Person ${id} via Computer`,
        `${id.toLowerCase()}@example.com`,
        Date.now(),
      );
    }
  });
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const frames: any[] = [];
  socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  socket.send(JSON.stringify({ t: "hello", protocol: 6, hostId: org, version: "test", sessions: [] }));
  await until(() => frames, (all) => all.some((frame) => frame.t === "welcome"), "welcome");
  return { stub, frames, socket };
}

describe("the computer object, around its queue", () => {
  it("looks at the size once more when a reconciliation is asked for while one runs", async () => {
    const stub = computers().getByName("org_q_reconcile");
    const runs = await inside(stub, async (instance) => {
      let runs = 0;
      instance.reconcileSizeOnce = async () => {
        runs += 1;
        await sleep(30);
      };
      // The second call (a hello's `size` alarm) joins the first, which may have read the row already.
      await Promise.all([instance.reconcileSize(), instance.reconcileSize()]);
      const afterTwo = runs;
      await instance.reconcileSize();
      return { afterTwo, afterThree: runs };
    });
    expect(runs).toEqual({ afterTwo: 2, afterThree: 3 });
  });

  it("keeps the unsealed credentials in memory until the bot token or model key changes", async () => {
    const { stub, socket } = await organization("org_q_creds", "T0QCREDS");
    const sizes = await inside(stub, async (instance) => {
      instance.unsealed.clear();
      await instance.credentials();
      const afterFirst = instance.unsealed.size;
      await instance.credentials();
      const afterSecond = instance.unsealed.size;
      return { afterFirst, afterSecond };
    });
    expect(sizes.afterFirst).toBeGreaterThan(0);
    expect(sizes.afterSecond).toBe(sizes.afterFirst);
    await stub.linkSlack("org_q_creds", { teamId: "T0QCREDS", teamName: "Queue", botUserId: "UBOTQ", botToken: "xoxb-queue-token-2" });
    const token = await inside(stub, async (instance) => (await instance.credentials()).slackBotToken as string);
    expect(token).toBe("xoxb-queue-token-2");
    socket.close();
  });
});
