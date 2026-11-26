import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";
import { generateTelemetryKeys, verifyTelemetryCredential } from "../src/computer/telemetry/credential.js";
import { checkEvent } from "../src/computer/telemetry/validate.js";
import { SLACK_BOT_TOKEN } from "./fixtures/computer-fakes.mjs";
import { linkSlack } from "./fixtures/computer-link.js";

/**
 * The computer gateway's telemetry end to end (work 054, S5 on bluecode):
 * the edge Worker and ComputerDurableObject with TINYBIRD_API_URL and
 * TINYBIRD_APPEND_TOKEN set, a fake Tinybird, a fake host socket and fake
 * Slack. The welcome carries a credential the
 * collector's public key accepts; and nothing content-shaped leaves.
 */

const ORIGIN = "https://managedagents.test";
const ORG = "org_telemetry";
const TEAM = "T0TELE";
const HOST_KEY = "test-computer-host-token-key";

type Namespace = DurableObjectNamespace<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: Namespace }).COMPUTERS;
const computer = () => computers().getByName(ORG);
const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(computer(), fn as never) as Promise<T>;

type Event = Record<string, any> & { event_name: string; data: string };
async function posts(reset = false): Promise<Array<{ datasource: string; token: string; down?: boolean; lines: Event[] }>> {
  const response = await fetch("https://tinybird.test/__posts", { method: reset ? "DELETE" : "GET" });
  return ((await response.json()) as { posts: Array<{ datasource: string; token: string; down?: boolean; lines: Event[] }> }).posts;
}
const events = async () => (await posts()).flatMap((post) => post.lines);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never: ${what}`);
}

function nextMessage(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), 5000);
    const listener = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      if (frame.t !== type) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(frame);
    };
    socket.addEventListener("message", listener);
  });
}

/** Every frame the gateway sends on `socket`, from now on. */
function record(socket: WebSocket): any[] {
  const frames: any[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    frames.push(JSON.parse(String(event.data)));
  });
  return frames;
}

async function connectHost(): Promise<{ socket: WebSocket; welcome: any; frames: any[] }> {
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ORG}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(HOST_KEY, ORG)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const frames = record(socket);
  const welcomed = nextMessage(socket, "welcome");
  socket.send(JSON.stringify({ t: "hello", protocol: 6, hostId: ORG, version: "host-1", sessions: [] }));
  return { socket, welcome: await welcomed, frames };
}

describe("computer telemetry", () => {
  it("issues host credentials, and sends nothing content-shaped", async () => {
    const keys = await generateTelemetryKeys();
    await inside((instance) => {
      instance.env.TELEMETRY_SIGNING_KEY = keys.signingKey;
      instance.env.TELEMETRY_COLLECTOR_URL = "https://telemetry.example";
    });
    await linkSlack(computer() as unknown as DurableObjectStub, ORG, { teamId: TEAM, teamName: "Tele", botUserId: "UBOTHELD", botToken: SLACK_BOT_TOKEN });
    await posts(true);

    // The host: its welcome carries a credential for this organization and host.
    const { socket, welcome } = await connectHost();
    expect(await verifyTelemetryCredential(keys.publicKey, welcome.telemetryCredential)).toEqual({
      org_id: ORG,
      host_id: ORG,
      exp: expect.any(Number),
    });
    expect(welcome.telemetryUrl).toBe("https://telemetry.example");
    const connected = await until(events, (all) => all.some((e) => e.event_name === "host.connected"), "host.connected");
    expect(connected.find((e) => e.event_name === "host.connected")).toMatchObject({ org_id: ORG, host_id: ORG, service_name: "gateway" });
    // The first hello read the organization's repositories (none connected here), timed by part;
    // its credentials were asked of the account.
    const defined = (await until(events, (all) => all.some((e) => e.event_name === "definition.refreshed"), "definition.refreshed")).find(
      (e) => e.event_name === "definition.refreshed",
    )!;
    expect(defined).toMatchObject({ org_id: ORG, outcome: "completed", duration_ms: expect.any(Number) });
    expect(JSON.parse(defined.data)).toEqual({ account_ms: expect.any(Number), github_ms: 0, repos: 0, changed: true, timed_out: false });
    const resolved = (await until(events, (all) => all.some((e) => e.event_name === "credentials.resolved"), "credentials.resolved")).filter(
      (e) => e.event_name === "credentials.resolved",
    );
    expect(JSON.parse(resolved[0]!.data)).toEqual({ source: "remote" });

    // The boundary: every record is a valid envelope, and no content, token or credential left.
    const all = await events();
    for (const line of all) expect(checkEvent({ ...line, data: JSON.parse(line.data) }).ok, line.event_name).toBe(true);
    const wire = JSON.stringify(await posts());
    for (const secret of ["fix the flaky build", SLACK_BOT_TOKEN, welcome.telemetryCredential, keys.signingKey, "sk-ant-test"]) {
      expect(wire).not.toContain(secret);
    }
    socket.close();
  });

  it("issues no credential to a pool computer's host", async () => {
    const poolId = "pool-telemetry1";
    const stub = computers().getByName(poolId);
    const keys = await generateTelemetryKeys();
    await runInDurableObject(stub, ((instance: any) => {
      instance.env.TELEMETRY_SIGNING_KEY = keys.signingKey;
    }) as never);
    const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${poolId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(HOST_KEY, poolId)}` },
    });
    const socket = upgraded.webSocket!;
    socket.accept();
    const welcomed = nextMessage(socket, "welcome");
    socket.send(JSON.stringify({ t: "hello", protocol: 6, hostId: poolId, version: "host-1", sessions: [] }));
    expect(await welcomed).not.toHaveProperty("telemetryCredential");
    socket.close();
  });
});
