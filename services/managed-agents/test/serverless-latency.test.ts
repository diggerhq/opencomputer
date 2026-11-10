import { afterEach, describe, expect, it, vi } from "vitest";
import { latencyTelemetry, upstreamTiming } from "../src/edge/latency.js";

/**
 * Serverless session latency spans (work 073): `time` returns or rethrows
 * what the work did, a session id learnt mid-request stamps every later
 * span, and the upstream hooks time headers and the first event.
 */

const ON = { TINYBIRD_API_URL: "https://api.tinybird.test/", TINYBIRD_APPEND_TOKEN: "p.append" };

function sent() {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 202 });
    }),
  );
  return () =>
    bodies
      .flatMap((body) => body.split("\n"))
      .map((line) => JSON.parse(line) as Record<string, any>);
}

afterEach(() => vi.unstubAllGlobals());

describe("serverless latency spans", () => {
  it("times work, keeps its result and stamps the session learnt later", async () => {
    const events = sent();
    const latency = latencyTelemetry(ON, "edge", {}, "SJC");
    const authenticated = await latency.time(
      "model_gateway.authenticated",
      async () => "sess_1",
      () => ({ capability: true }),
    );
    expect(authenticated).toBe("sess_1");
    latency.base.session_key = authenticated;
    await expect(
      latency.time("model_gateway.billing_checked", async () => {
        throw new Error("billing down");
      }),
    ).rejects.toThrow("billing down");
    const context = { promises: [] as Promise<unknown>[], waitUntil(p: Promise<unknown>) { this.promises.push(p); } };
    latency.send(context);
    await Promise.all(context.promises);

    const [auth, billing] = events();
    expect(auth).toMatchObject({ event_name: "model_gateway.authenticated", service_name: "edge", region: "SJC" });
    expect(auth!.session_key).toBeFalsy();
    expect(JSON.parse(auth!.data)).toEqual({ capability: true });
    expect(billing).toMatchObject({ event_name: "model_gateway.billing_checked", session_key: "sess_1", outcome: "failed" });
  });

  it("times upstream headers, then the first event", async () => {
    const events = sent();
    const latency = latencyTelemetry(ON, "edge", { session_key: "sess_1" });
    const timing = upstreamTiming(latency, "openrouter", "chat_completions");
    timing.upstreamResponded(200);
    timing.firstEvent(512);
    await latency.done();

    const [responded, first] = events();
    expect(responded).toMatchObject({ event_name: "model_gateway.upstream_responded", session_key: "sess_1" });
    expect(JSON.parse(responded!.data)).toEqual({ status: 200, upstream: "openrouter", protocol: "chat_completions" });
    expect(first).toMatchObject({ event_name: "model_gateway.first_event" });
    expect(JSON.parse(first!.data)).toEqual({ bytes: 512 });
  });
});
