import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { noModelAccess } from "../src/computer/model-access.js";

/**
 * Work 097, 6b, in the real ComputerDurableObject: with the public build's
 * ModelAccess (no `slack`), `!claude` is not a command; the text goes to
 * the session like any other. (The hosted one answers it in Slack:
 * computer-hosted-do.test.ts.)
 */

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

async function slackCalls(): Promise<Array<{ method: string; body: any }>> {
  const response = await fetch("https://slack.test/__calls");
  return ((await response.json()) as { calls: Array<{ method: string; body: any }> }).calls;
}

/** A linked organization whose deliveries are collected instead of sent to a host. */
async function organization(org: string, team: string): Promise<Stub> {
  await computers().getByName(`computer-slack-team:${team}`).claimTeam(team, org);
  const stub = computers().getByName(org);
  await stub.linkSlack(org, { teamId: team, teamName: "Seam", botUserId: "UBOTS", botToken: "xoxb-seam-token" });
  await inside(stub, (instance, state) => {
    state.storage.sql.exec(
      "INSERT OR IGNORE INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES (?, ?, ?, ?, ?)",
      "U1",
      "slack-u1",
      "Person U1 via Computer",
      "u1@example.com",
      Date.now(),
    );
    instance.deliveries = [];
    instance.deliver = async (dispatch: any) => instance.deliveries.push(dispatch.text);
  });
  return stub;
}

const job = (team: string, messageTs: string, text: string) => ({
  eventId: `Ev-${team}-${messageTs}`,
  teamId: team,
  channelId: "CSEAMPUB",
  threadTs: messageTs,
  messageTs,
  userId: "U1",
  text,
  mentioned: true,
  receivedAt: Date.now(),
});
const deliveries = (stub: Stub) => inside(stub, (instance) => instance.deliveries as string[]);
// By channel, never by clearing the fake: other files' tests read its calls at the same time.
const claudeAnswers = async () => (await slackCalls()).filter((c) => c.method === "chat.postEphemeral" && c.body.channel === "CSEAMPUB" && typeof c.body.text === "string" && c.body.text.includes("!claude"));

describe("ModelAccess in the Durable Object", () => {
  it("without `slack`, `!claude` is not intercepted: the text reaches the session", async () => {
    const stub = await organization("org_seam_public", "T0SEAMPUB");
    await inside(stub, (instance) => {
      instance.access = noModelAccess({ harnesses: () => ["claude"] });
    });
    await stub.acceptSlackEvent("org_seam_public", job("T0SEAMPUB", "21.1", "<@UBOTS> !claude help"));
    await until(() => deliveries(stub), (all) => all.length === 1, "delivery");
    expect(await deliveries(stub)).toEqual(["!claude help"]);
    expect(await claudeAnswers()).toEqual([]);
  });
});
