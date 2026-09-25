import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyManagedAgents } from "./managed_agents";

const env = {
  OC_MANAGED_AGENTS_SECRET: "test-secret",
  MANAGED_AGENTS_API_URL: "https://managedagents.test",
};
const caller = { orgID: "org_test", userID: "user_test" };

function call(path: string, init?: RequestInit): Promise<Response> {
  return proxyManagedAgents(
    new Request(`https://app.opencomputer.dev/api/managed-agents${path}`, init),
    env,
    caller,
    "/api/managed-agents",
  );
}

function upstreamTargets(fetchSpy: ReturnType<typeof vi.fn>): string[] {
  return fetchSpy.mock.calls.map((entry) => String((entry as unknown[])[0]));
}

describe("long-poll event pages (07)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards wait/limit/turn and keeps cursor, session, turn and waitExpired", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        events: [],
        cursor: { requestedAfter: 32, nextAfter: 32, highWatermark: 32 },
        session: { status: "running", terminal: false },
        turn: { id: "turn_1", status: "running", terminal: false },
        waitExpired: true,
        runtimeToken: "never-return-this",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await call(
      "/sessions/session-1/events?after=32&wait=20&limit=100&turn=turn_1",
    );
    expect(response.status).toBe(200);
    expect(upstreamTargets(fetchSpy)).toEqual([
      "https://managedagents.test/v1/sessions/session-1/events?after=32&wait=20&limit=100&turn=turn_1",
    ]);
    const body = await response.json();
    expect(body).toEqual({
      events: [],
      cursor: { requestedAfter: 32, nextAfter: 32, highWatermark: 32 },
      session: { status: "running", terminal: false },
      turn: { id: "turn_1", status: "running", terminal: false },
      waitExpired: true,
    });
    expect(JSON.stringify(body)).not.toContain("never-return-this");
  });

  it("keeps a page's events unchanged and a null turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          events: [
            {
              id: "event_1",
              seq: 33,
              timestamp: "2026-09-25T00:00:00.000Z",
              sessionId: "session-1",
              turnId: "turn_1",
              type: "turn.completed",
              data: { status: "completed" },
            },
          ],
          cursor: { requestedAfter: 32, nextAfter: 33, highWatermark: 33 },
          session: { status: "ended", terminal: true },
          turn: null,
          waitExpired: false,
        }),
      ),
    );
    const body = await (await call("/sessions/session-1/events?after=32")).json();
    expect(body).toMatchObject({
      events: [{ id: "event_1", seq: 33, type: "turn.completed" }],
      cursor: { requestedAfter: 32, nextAfter: 33, highWatermark: 33 },
      session: { status: "ended", terminal: true },
      turn: null,
      waitExpired: false,
    });
  });

  it("returns only the events array from an older backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ events: [] })),
    );
    const body = await (await call("/sessions/session-1/events?after=0")).json();
    expect(body).toEqual({ events: [] });
  });

  it("keeps the backend's waiter-limit and query errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "too_many_waiters",
              message: "At most 32 requests may wait on one session at a time",
            },
          },
          { status: 429, headers: { "retry-after": "1" } },
        ),
      ),
    );
    const response = await call("/sessions/session-1/events?after=0&wait=30");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({
      error: { code: "too_many_waiters" },
    });
  });
});

describe("HTTPS event delivery (12)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const subscription = {
    id: "evs_1",
    projectId: "prj_1",
    agentId: "worker",
    environment: "development",
    events: ["turn.completed", "turn.failed", "turn.cancelled"],
    destination: { type: "https", url: "https://receiver.example/oc" },
    status: "active",
    createdBy: "user_private",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
  const publicSubscription = {
    id: "evs_1",
    projectId: "prj_1",
    agentId: "worker",
    environment: "development",
    events: ["turn.completed", "turn.failed", "turn.cancelled"],
    destination: { type: "https", url: "https://receiver.example/oc" },
    status: "active",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
  const delivery = {
    id: "dlv_1",
    subscriptionId: "evs_1",
    projectId: "prj_1",
    environment: "development",
    agentId: "worker",
    sessionId: "ses_1",
    turnId: "turn_1",
    eventId: "event_1",
    eventType: "turn.completed",
    sequence: 42,
    occurredAt: "2026-09-25T00:00:00.000Z",
    status: "pending",
    attempt: 2,
    nextAttemptAt: "2026-09-25T00:00:45.000Z",
    lastAttemptAt: "2026-09-25T00:00:00.000Z",
    responseStatus: 429,
    error: "Receiver answered 429",
    accountId: "acct_private",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
  const { accountId: _accountId, ...publicDelivery } = delivery;

  it("returns the signing secret once, on creation and rotation only", async () => {
    const fetchSpy = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/rotate-secret")) {
        return Response.json({
          subscription: { ...subscription, secretRotatedAt: "2026-09-25T01:00:00.000Z" },
          signingSecret: "ocsk_rotated",
        });
      }
      if (url.endsWith("/event-subscriptions")) {
        return Response.json(
          { subscription, signingSecret: "ocsk_created" },
          { status: 201 },
        );
      }
      return Response.json({ subscription });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const created = await call("/projects/prj_1/event-subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment: "development",
        agentId: "worker",
        events: ["turn.completed"],
        destination: { type: "https", url: "https://receiver.example/oc" },
      }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toEqual({
      subscription: publicSubscription,
      signingSecret: "ocsk_created",
    });

    const read = await call("/projects/prj_1/event-subscriptions/evs_1");
    expect(await read.json()).toEqual({ subscription: publicSubscription });

    const rotated = await call(
      "/projects/prj_1/event-subscriptions/evs_1/rotate-secret",
      { method: "POST" },
    );
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    expect(await rotated.json()).toEqual({
      subscription: {
        ...publicSubscription,
        secretRotatedAt: "2026-09-25T01:00:00.000Z",
      },
      signingSecret: "ocsk_rotated",
    });
    expect(JSON.stringify(fetchSpy.mock.results)).not.toContain("user_test");
  });

  it("pauses and resumes a subscription", async () => {
    const fetchSpy = vi.fn(async (input: URL | string) =>
      Response.json({
        subscription: {
          ...subscription,
          status: String(input).endsWith("/pause") ? "paused" : "active",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const paused = await call(
      "/projects/prj_1/event-subscriptions/evs_1/pause",
      { method: "POST" },
    );
    expect(await paused.json()).toEqual({
      subscription: { ...publicSubscription, status: "paused" },
    });
    const resumed = await call(
      "/projects/prj_1/event-subscriptions/evs_1/resume",
      { method: "POST" },
    );
    expect(await resumed.json()).toEqual({ subscription: publicSubscription });
    expect(upstreamTargets(fetchSpy)).toEqual([
      "https://managedagents.test/v1/projects/prj_1/event-subscriptions/evs_1/pause",
      "https://managedagents.test/v1/projects/prj_1/event-subscriptions/evs_1/resume",
    ]);
  });

  it("lists and reads deliveries with their query forwarded", async () => {
    const fetchSpy = vi.fn(async (input: URL | string) =>
      String(input).includes("/deliveries/")
        ? Response.json({ delivery })
        : Response.json({ deliveries: [delivery], nextCursor: "dlv_1" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const listed = await call(
      "/projects/prj_1/event-subscriptions/evs_1/deliveries?status=pending&sessionId=ses_1&limit=10",
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      deliveries: [publicDelivery],
      nextCursor: "dlv_1",
    });

    const read = await call(
      "/projects/prj_1/event-subscriptions/evs_1/deliveries/dlv_1",
    );
    expect(await read.json()).toEqual({ delivery: publicDelivery });
    expect(upstreamTargets(fetchSpy)).toEqual([
      "https://managedagents.test/v1/projects/prj_1/event-subscriptions/evs_1/deliveries?status=pending&sessionId=ses_1&limit=10",
      "https://managedagents.test/v1/projects/prj_1/event-subscriptions/evs_1/deliveries/dlv_1",
    ]);
    expect(JSON.stringify(fetchSpy.mock.results)).not.toContain("user_test");
  });

  it("replays deliveries, forwarding the selection as sent", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json(
        {
          deliveries: [
            {
              ...delivery,
              id: "dlv_2",
              status: "pending",
              attempt: 0,
              replayOf: "dlv_1",
            },
          ],
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const selection = { sessionId: "ses_1", fromSequence: 40, toSequence: 45 };

    const response = await call(
      "/projects/prj_1/event-subscriptions/evs_1/replay",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selection),
      },
    );
    expect(response.status).toBe(202);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(await new Response(init.body).json()).toEqual(selection);
    expect(await response.json()).toEqual({
      deliveries: [
        {
          ...publicDelivery,
          id: "dlv_2",
          status: "pending",
          attempt: 0,
          replayOf: "dlv_1",
        },
      ],
    });
  });

  it("keeps a turn's HTTPS hand-off receipt (deliveryId) on the session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "session-1",
          agentId: "worker",
          deploymentId: "dep_1",
          status: "idle",
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:01.000Z",
          turns: [
            {
              id: "turn_1",
              input: "go",
              mode: "queue",
              status: "completed",
              createdAt: "2026-09-25T00:00:00.000Z",
              updatedAt: "2026-09-25T00:00:01.000Z",
              deliveries: [
                {
                  id: "evs_1:event_1",
                  subscriptionId: "evs_1",
                  eventId: "event_1",
                  eventType: "turn.completed",
                  destination: { type: "https", url: "https://receiver.example/oc" },
                  status: "delivered",
                  attempt: 1,
                  deliveryId: "dlv_1",
                  updatedAt: "2026-09-25T00:00:01.000Z",
                },
              ],
            },
          ],
        }),
      ),
    );
    const response = await call("/sessions/session-1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      turns: { deliveries: Record<string, unknown>[] }[];
    };
    expect(body.turns[0]?.deliveries[0]).toEqual({
      id: "evs_1:event_1",
      subscriptionId: "evs_1",
      eventId: "event_1",
      eventType: "turn.completed",
      destination: { type: "https", url: "https://receiver.example/oc" },
      status: "delivered",
      attempt: 1,
      deliveryId: "dlv_1",
      updatedAt: "2026-09-25T00:00:01.000Z",
    });
  });

  it("does not admit other methods on delivery routes", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const [path, method] of [
      ["/projects/prj_1/event-subscriptions/evs_1/deliveries", "POST"],
      ["/projects/prj_1/event-subscriptions/evs_1/deliveries/dlv_1", "DELETE"],
      ["/projects/prj_1/event-subscriptions/evs_1/replay", "GET"],
      ["/projects/prj_1/event-subscriptions/evs_1/pause", "GET"],
      ["/projects/prj_1/event-subscriptions/evs_1/rotate-secret", "DELETE"],
      ["/projects/prj_1/event-subscriptions/evs_1/unknown", "POST"],
    ] as const) {
      const response = await call(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
