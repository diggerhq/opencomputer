import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenCode2ReactiveHarness } from "../src/runtime/opencode2-harness.js";

describe("OpenCode 2 harness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Stale: the harness gives OpenCode its directory as the session's
  // `location`, not a header. It was never in a vitest project, so it never
  // ran; kept until it is rewritten for the location.
  it.skip("routes every API request to its encoded workspace", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/api/health")) {
          return Response.json({ healthy: true });
        }
        return Response.json({ data: { id: "ses_test" } });
      }),
    );

    const harness = new OpenCode2ReactiveHarness(
      "http://127.0.0.1:4096",
      "/tmp/workspace with spaces/日本語",
      "openrouter/anthropic/claude-sonnet-4.6",
      undefined,
      "secret",
    );
    await harness.start();

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new Headers(request.init?.headers).get("x-opencode-directory")).toBe(
        encodeURIComponent("/tmp/workspace with spaces/日本語"),
      );
    }
  });

  it("uses explicit OpenCode delivery and interruption endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/api/health")) {
          return Response.json({ healthy: true });
        }
        return Response.json({ data: { id: "ses_modes" } });
      }),
    );
    const harness = new OpenCode2ReactiveHarness(
      "http://127.0.0.1:4096",
      "/tmp/workspace",
      "openrouter/anthropic/claude-sonnet-4.6",
    );
    await harness.start();

    await harness.steer("focus on the failing test");
    await harness.interrupt();

    const steer = requests.find(({ url }) => url.endsWith("/prompt"));
    expect(steer?.init?.method).toBe("POST");
    expect(JSON.parse(String(steer?.init?.body))).toEqual({
      text: "focus on the failing test",
      delivery: "steer",
    });
    expect(requests.at(-1)).toMatchObject({
      url: "http://127.0.0.1:4096/api/session/ses_modes/interrupt",
      init: { method: "POST" },
    });
  });

  it("ends the turn after a successful ask, interrupting OpenCode, and hands back the question", async () => {
    const sessionID = "ses_ask";
    const requests: string[] = [];
    const encoder = new TextEncoder();
    let push: (event: Record<string, unknown>) => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    });
    const emit = (type: string, data: Record<string, unknown> = {}) => push({ type, data: { sessionID, ...data } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        requests.push(path);
        if (path === "/api/health") return Response.json({ healthy: true });
        if (path === "/api/event") return new Response(stream);
        if (path.endsWith("/prompt")) {
          queueMicrotask(() => {
            emit("session.tool.input.started", { id: "call-ask", name: "ask", assistantMessageID: "msg-1" });
            emit("session.tool.called", {
              id: "call-ask",
              input: { text: "Which language?", options: [{ label: "Go", value: "go" }] },
            });
            emit("session.tool.success", { id: "call-ask", content: [{ type: "text", text: "recorded" }] });
          });
          return Response.json({ data: {} });
        }
        if (path.endsWith("/interrupt")) {
          // What OpenCode answers an interrupt with: no idle, no success.
          queueMicrotask(() => {
            emit("session.step.failed");
            emit("session.execution.interrupted");
          });
          return new Response(null, { status: 204 });
        }
        return Response.json({ data: { id: sessionID } });
      }),
    );
    const harness = new OpenCode2ReactiveHarness("http://127.0.0.1:4096", "/tmp/workspace", "openrouter/x");
    await harness.start();

    const events = [];
    for await (const event of harness.run({ turnId: "turn-1", input: "go", agentInput: { source: "user", text: "go" } })) {
      events.push(event.type);
    }

    expect(events).toEqual(["tool.started", "tool.completed", "message.completed"]);
    expect(requests.filter((path) => path.endsWith("/interrupt"))).toHaveLength(1);
    expect(harness.takeQuestion()).toEqual({
      callId: "call-ask",
      text: "Which language?",
      options: [{ label: "Go", value: "go" }],
    });
    // Read once: the next turn does not inherit it.
    expect(harness.takeQuestion()).toBeUndefined();
  });
});
