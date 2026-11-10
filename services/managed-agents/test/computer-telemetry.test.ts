import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalvinGatewayToHost, CalvinTraceContext } from "../src/computer/protocol.js";
import {
  CREDENTIAL_TTL_S,
  generateTelemetryKeys,
  issueTelemetryCredential,
  verifyTelemetryCredential,
} from "../src/computer/telemetry/credential.js";
import { gatewayTelemetry, mintTrace, slackTsMs, telemetryEnabled, traceFields } from "../src/computer/telemetry/gateway.js";
import fixture from "./fixtures/calvin-deliver-trace.json" with { type: "json" };

/**
 * The computer gateway's telemetry (work 054, S5 ported from dash-cal#17):
 * the off switch, one batch per invocation, retries that never reject, the
 * data boundary on the gateway's own events, the trace context against
 * Calvin's deliver fixture, and host credentials against the collector's
 * reference issuer and verifier.
 */

const ON = { TINYBIRD_API_URL: "https://api.tinybird.test/", TINYBIRD_APPEND_TOKEN: "p.append", CF_VERSION_METADATA: { id: "ver-1" } };
const TRACE = { id: "019a3b4c-0000-7000-8000-000000000001", sentAt: 1791840900000, receivedAt: 1791840900180 };

function poster(...statuses: Array<number | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
const lines = (init: RequestInit) => String(init.body).split("\n").map((line) => JSON.parse(line) as Record<string, any>);

afterEach(() => vi.restoreAllMocks());

describe("gateway telemetry: off unless configured", () => {
  it.each([
    ["nothing set", {}],
    ["only the token", { TINYBIRD_APPEND_TOKEN: "p.append" }],
    ["only the URL", { TINYBIRD_API_URL: "https://api.tinybird.test" }],
    ["blank values", { TINYBIRD_API_URL: " ", TINYBIRD_APPEND_TOKEN: " " }],
  ])("sends nothing and waits for nothing with %s", async (_, env) => {
    const p = poster(202);
    const t = gatewayTelemetry(env, { fetch: p.fetch });
    expect(t.enabled).toBe(telemetryEnabled(env));
    expect(t.enabled).toBe(false);
    t.emit("message.received", { trace_id: TRACE.id });
    // An acknowledgement that never settles must not hold the invocation open.
    t.wait(new Promise(() => {}));
    const started = Date.now();
    await t.done();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(p.calls).toHaveLength(0);
    expect(t.buffered).toBe(0);
  });
});

describe("gateway telemetry: sending", () => {
  it("sends one NDJSON batch per invocation, including an ack that resolves after the work", async () => {
    const p = poster(202);
    const t = gatewayTelemetry(ON, { region: "SJC", fetch: p.fetch, base: { trace_id: TRACE.id, org_id: "org_1" } });
    t.emit("queue.started", { data: { attempt: 1 } });
    // process() has returned; the acknowledgement is still in flight (waitUntil).
    t.wait(
      new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
        t.emit("ack.done", { duration_ms: 640, outcome: "completed", data: { indicator: "status", call_ms: 210 } }),
      ),
    );
    await t.done();
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.url).toBe("https://api.tinybird.test/v0/events?name=calvin_events&wait=false");
    expect(new Headers(p.calls[0]!.init.headers).get("authorization")).toBe("Bearer p.append");
    const sent = lines(p.calls[0]!.init);
    expect(sent.map((event) => event.event_name)).toEqual(["queue.started", "ack.done"]);
    expect(sent[1]).toMatchObject({ trace_id: TRACE.id, org_id: "org_1", service_name: "gateway", service_version: "ver-1", region: "SJC", duration_ms: 640 });
    expect(JSON.parse(sent[1]!.data)).toEqual({ indicator: "status", call_ms: 210 });
  });

  it("makes no request when nothing was emitted", async () => {
    const p = poster(202);
    await gatewayTelemetry(ON, { fetch: p.fetch }).done();
    expect(p.calls).toHaveLength(0);
  });

  it("retries a 5xx, a 429 or a network failure once, never another 4xx, and never rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases = [
      [[500], 2],
      [[429], 2],
      [[new Error("reset")], 2],
      [[503, 202], 2],
      [[400], 1],
    ] as const;
    for (const [statuses, calls] of cases) {
      const p = poster(...statuses);
      const t = gatewayTelemetry(ON, { fetch: p.fetch });
      t.emit("dispatch.parked");
      await expect(t.done()).resolves.toBeUndefined();
      expect(p.calls).toHaveLength(calls);
    }
    // Every case but the retried 503 lost its batch, and says so in Workers Logs.
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("never throws or rejects when fetch itself throws synchronously", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = gatewayTelemetry(ON, {
      fetch: (() => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    });
    t.emit("dispatch.parked");
    await expect(t.done()).resolves.toBeUndefined();
  });

  it("drops content-shaped records instead of sending them, and counts them", async () => {
    const p = poster(202);
    const t = gatewayTelemetry(ON, { fetch: p.fetch });
    t.emit("message.ignored", { data: { reason: "xoxb-123-secret" } });
    t.emit("message.ignored", { data: { reason: "see /etc/passwd" } });
    t.emit("command.handled", { data: { command: "secret", text: "rm KEY\nand more" } as never });
    t.emit("dispatch.sent", { conversation_id: "Bearer abc", data: { attempt: 1 } });
    t.emit("ack.done", { error_code: "Error: ENOENT, open /data/x" });
    t.emit("host.connected", { host_id: "x".repeat(300) });
    await t.done();
    const sent = lines(p.calls[0]!.init);
    expect(sent.map((event) => event.event_name)).toEqual(["telemetry.dropped"]);
    expect(JSON.parse(sent[0]!.data)).toEqual({ reason: "invalid", count: 6 });
  });
});

describe("trace context", () => {
  it("mints a trace from Slack's own message time", () => {
    const trace = mintTrace(
      ON,
      { teamId: "T1", channelId: "C1", userId: "U1", messageTs: "1791840900.000100", receivedAt: TRACE.receivedAt, eventId: "Ev1" },
      { region: "SJC" },
    );
    expect(trace).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
      sentAt: 1791840900000,
      receivedAt: TRACE.receivedAt,
      surface: "slack",
      surfaceWorkspaceId: "T1",
      conversationId: "C1",
      personId: "U1",
      surfaceEventId: "Ev1",
      gatewayVersion: "ver-1",
      gatewayRegion: "SJC",
    });
    expect(slackTsMs("1791840900.999900")).toBe(1791840901000);
    expect(mintTrace({}, { teamId: "T", channelId: "C", userId: "U", messageTs: "1.1", receivedAt: 5 }).gatewayVersion).toBe("dev");
  });

  it("gives every event of a trace its envelope fields", () => {
    const fields = traceFields({ ...TRACE, surface: "slack", surfaceWorkspaceId: "T1", conversationId: "C1", personId: "U1" });
    expect(fields).toEqual({
      trace_id: TRACE.id,
      surface: "slack",
      surface_workspace_id: "T1",
      conversation_id: "C1",
      person_id: "U1",
      sent_at: "2026-10-12 21:35:00.000",
    });
    expect(traceFields(undefined)).toEqual({});
  });

  it("matches Calvin's deliver contract fixture (calvin src/telemetry/deliver-trace.fixture.json)", () => {
    // Calvin's fixture is a deliver frame this gateway can send.
    const frame: CalvinGatewayToHost = fixture as CalvinGatewayToHost;
    expect(JSON.parse(JSON.stringify(frame))).toEqual(fixture);
    // Every trace field the gateway sets is one Calvin's fixture carries, and the reverse.
    const ours: Required<Omit<CalvinTraceContext, "path" | "hostReceivedAt" | "runnerReadyAt" | "forkMs" | "launchMs">> = {
      ...TRACE,
      dispatchedAt: 1,
      surface: "slack",
      surfaceWorkspaceId: "T",
      conversationId: "C",
      personId: "U",
      surfaceEventId: "Ev",
      gatewayVersion: "v",
      gatewayRegion: "SJC",
      gatewaySessionId: "s",
      synthetic: false,
    };
    expect(Object.keys(ours).sort()).toEqual(Object.keys(fixture.trace).sort());
    // A minted trace stamped at send is the fixture's shape (less the optional session id and synthetic flag).
    const minted = { ...mintTrace(ON, { teamId: "T", channelId: "C", userId: "U", messageTs: "1.1", receivedAt: 5, eventId: "Ev" }, { region: "SJC" }), dispatchedAt: 6 };
    expect(Object.keys(fixture.trace)).toEqual(expect.arrayContaining(Object.keys(minted)));
  });
});

// ---------------------------------------------------------------- credentials

// Calvin's collector (telemetry/collector/src/credential.ts at 017d8db), verbatim
// but for types: the reference issuer and the verifier our credentials must pass.
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function collectorSign(claims: { org_id: string; host_id: string; exp: number }, privateKey: CryptoKey): Promise<string> {
  const body = `v1.${b64url(new TextEncoder().encode(JSON.stringify(claims)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}
async function collectorVerify(token: string, publicKey: string, nowS: number): Promise<{ org_id: string; host_id: string; exp: number } | undefined> {
  const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return undefined;
    const key = await crypto.subtle.importKey("raw", unb64url(publicKey), { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, unb64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) return undefined;
    const { org_id, host_id, exp } = JSON.parse(new TextDecoder().decode(unb64url(parts[1]!))) as Record<string, unknown>;
    if (typeof org_id !== "string" || !ID.test(org_id) || typeof host_id !== "string" || !ID.test(host_id)) return undefined;
    if (typeof exp !== "number" || !(exp > nowS)) return undefined;
    return { org_id, host_id, exp };
  } catch {
    return undefined;
  }
}

describe("telemetry credentials", () => {
  const now = Date.UTC(2026, 9, 12);
  const host = { orgId: "org_01JABCDEF", hostId: "org_01JABCDEF" };

  it("are byte-identical to the collector's reference issuer and pass its verifier", async () => {
    const keys = await generateTelemetryKeys();
    const credential = await issueTelemetryCredential(keys.signingKey, host, now);
    expect(credential).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const privateKey = await crypto.subtle.importKey("pkcs8", unb64url(keys.signingKey), { name: "Ed25519" }, false, ["sign"]);
    const exp = now / 1000 + CREDENTIAL_TTL_S;
    expect(credential).toBe(await collectorSign({ org_id: host.orgId, host_id: host.hostId, exp }, privateKey));
    expect(await collectorVerify(credential, keys.publicKey, now / 1000)).toEqual({ org_id: host.orgId, host_id: host.hostId, exp });
    expect(exp - now / 1000).toBe(90 * 86400);
  });

  it("accept a PKCS#8 signing key in standard base64 too", async () => {
    const keys = await generateTelemetryKeys();
    const standard = btoa(String.fromCharCode(...unb64url(keys.signingKey)));
    const credential = await issueTelemetryCredential(standard, host, now);
    expect(await verifyTelemetryCredential(keys.publicKey, credential, now)).toMatchObject({ org_id: host.orgId });
  });

  it("are refused when expired, signed by another key, or forged", async () => {
    const keys = await generateTelemetryKeys();
    const credential = await issueTelemetryCredential(keys.signingKey, host, now);
    expect(await verifyTelemetryCredential(keys.publicKey, credential, now)).toEqual({ org_id: host.orgId, host_id: host.hostId, exp: now / 1000 + CREDENTIAL_TTL_S });
    expect(await verifyTelemetryCredential(keys.publicKey, credential, now + 91 * 86400_000)).toBeNull();
    expect(await collectorVerify(credential, keys.publicKey, now / 1000 + 91 * 86400)).toBeUndefined();
    const other = await generateTelemetryKeys();
    expect(await verifyTelemetryCredential(other.publicKey, credential, now)).toBeNull();
    // A forged organization breaks the signature.
    const [v, payload, sig] = credential.split(".") as [string, string, string];
    const forged = b64url(new TextEncoder().encode(new TextDecoder().decode(unb64url(payload)).replace(host.orgId, "org_other")));
    expect(await verifyTelemetryCredential(keys.publicKey, `${v}.${forged}.${sig}`, now)).toBeNull();
    expect(await collectorVerify(`${v}.${forged}.${sig}`, keys.publicKey, now / 1000)).toBeUndefined();
  });

  it("are never issued for ids the collector would reject", async () => {
    const keys = await generateTelemetryKeys();
    await expect(issueTelemetryCredential(keys.signingKey, { orgId: "org/../x", hostId: "h" })).rejects.toThrow(/invalid/);
    await expect(issueTelemetryCredential(keys.signingKey, { orgId: "org", hostId: "" })).rejects.toThrow(/invalid/);
  });
});
