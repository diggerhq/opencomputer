import { describe, expect, expectTypeOf, it } from "vitest";

import { OpenComputer } from "./client.js";
import { OpenComputerError } from "./errors.js";
import {
  EVENT_DELIVERY_HEADERS,
  eventSigningInput,
  parseEventDelivery,
  signEventDelivery,
  verifyEventDelivery,
  type EventDelivery,
  type EventDeliveryEnvelope,
  type ReplayEventDeliveriesSelection,
} from "./event-delivery.js";
import type { EventPage } from "./types.js";

interface Call { method: string; path: string; body?: unknown }

function fakeApi(routes: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: `${url.pathname}${url.search}` };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body) as unknown;
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (route) return route(call);
    return Response.json({ error: { code: "not_found", message: `no route ${call.method} ${url.pathname}` } }, { status: 404 });
  };
  return { calls, fetch, last: () => calls[calls.length - 1] };
}

const oc = (api: ReturnType<typeof fakeApi>) => new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });

// ── 07: long-poll event pages ────────────────────────────────────────────────

describe("sessions.events.page", () => {
  const page: EventPage = {
    events: [],
    cursor: { requestedAfter: 32, nextAfter: 32, highWatermark: 32 },
    session: { status: "running", terminal: false },
    turn: { id: "turn_1", status: "running", terminal: false },
    waitExpired: true,
  };

  it("sends after, wait, limit and turn and returns the page with its metadata", async () => {
    const api = fakeApi({ "GET /api/managed-agents/sessions/ses_1/events": () => Response.json(page) });
    const answer = await oc(api).sessions.events.page("ses_1", { after: 32, wait: 20, limit: 100, turn: "turn_1" });
    expect(answer).toEqual(page);
    expect(api.last().path).toBe("/api/managed-agents/sessions/ses_1/events?after=32&wait=20&limit=100&turn=turn_1");
    expectTypeOf(answer.cursor).toEqualTypeOf<EventPage["cursor"]>();
  });

  it("sends only after by default and accepts a page without metadata", async () => {
    const events = [{ id: "e1", seq: 1, type: "session.created", data: {} }];
    const api = fakeApi({ "GET /api/managed-agents/sessions/ses_1/events": () => Response.json({ events }) });
    expect(await oc(api).sessions.events.page("ses_1")).toEqual({ events });
    expect(api.last().path).toBe("/api/managed-agents/sessions/ses_1/events?after=0");
    expect(await oc(api).sessions.events.list("ses_1", { after: 3, wait: 5 })).toEqual(events);
    expect(api.last().path).toBe("/api/managed-agents/sessions/ses_1/events?after=3&wait=5");
  });

  it("accepts a null turn and a terminal session", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1/events": () =>
        Response.json({ ...page, session: { status: "ended", terminal: true }, turn: null, waitExpired: false }),
    });
    const answer = await oc(api).sessions.events.page("ses_1", { after: 32 });
    expect(answer.turn).toBeNull();
    expect(answer.session).toEqual({ status: "ended", terminal: true });
  });

  it("surfaces the waiter limit as the API's error", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1/events": () =>
        Response.json({ error: { code: "too_many_waiters", message: "At most 32 requests may wait on one session" } }, { status: 429 }),
    });
    const error = await oc(api).sessions.events.page("ses_1", { wait: 30 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenComputerError);
    expect((error as OpenComputerError).code).toBe("too_many_waiters");
  });
});

// ── 12: HTTPS subscriptions and deliveries ───────────────────────────────────

const subscription = {
  id: "evs_1",
  projectId: "prj_1",
  agentId: "worker",
  environment: "development",
  events: ["turn.completed", "turn.failed", "turn.cancelled"],
  destination: { type: "https", url: "https://receiver.example/oc" },
  status: "active",
  createdAt: "t",
  updatedAt: "t",
};

const delivery: EventDelivery = {
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
  occurredAt: "t",
  status: "pending",
  attempt: 2,
  nextAttemptAt: "t2",
  lastAttemptAt: "t1",
  responseStatus: 500,
  error: "http_500",
  createdAt: "t",
  updatedAt: "t1",
};

describe("projects.eventSubscriptions (HTTPS)", () => {
  it("creates an HTTPS subscription and returns its one-time signing secret", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/projects/prj_1/event-subscriptions": () =>
        Response.json({ subscription, signingSecret: "ocsk_once" }, { status: 201 }),
      "GET /api/managed-agents/projects/prj_1/event-subscriptions/evs_1": () => Response.json({ subscription }),
    });
    const created = await oc(api).projects.eventSubscriptions.create("prj_1", {
      environment: "development",
      agentId: "worker",
      events: ["turn.completed", "turn.failed", "turn.cancelled"],
      destination: { type: "https", url: "https://receiver.example/oc" },
    });
    expect(created).toEqual({ ...subscription, signingSecret: "ocsk_once" });
    expect(api.last().body).toMatchObject({ destination: { type: "https", url: "https://receiver.example/oc" } });
    const read = await oc(api).projects.eventSubscriptions.get("prj_1", "evs_1");
    expect(read).toEqual(subscription);
    expect("signingSecret" in read).toBe(false);
  });

  it("still returns a session-destination subscription without a secret", async () => {
    const session = { ...subscription, destination: { type: "session", sessionId: "ses_c" }, status: undefined, updatedAt: undefined };
    const api = fakeApi({
      "POST /api/managed-agents/projects/prj_1/event-subscriptions": () =>
        Response.json({ subscription: { id: "evs_2", projectId: "prj_1", events: ["turn.completed"], destination: session.destination, createdAt: "t" } }, { status: 201 }),
    });
    const created = await oc(api).projects.eventSubscriptions.create("prj_1", { events: ["turn.completed"], destination: { type: "session", sessionId: "ses_c" } });
    expect(created).toEqual({ id: "evs_2", projectId: "prj_1", events: ["turn.completed"], destination: { type: "session", sessionId: "ses_c" }, createdAt: "t" });
    expect(created.signingSecret).toBeUndefined();
  });

  it("pauses, resumes and rotates the secret on the documented routes", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/pause": () =>
        Response.json({ subscription: { ...subscription, status: "paused" } }),
      "POST /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/resume": () => Response.json({ subscription }),
      "POST /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/rotate-secret": () =>
        Response.json({ subscription: { ...subscription, secretRotatedAt: "t3" }, signingSecret: "ocsk_new" }),
    });
    const subs = oc(api).projects.eventSubscriptions;
    expect((await subs.pause("prj_1", "evs_1")).status).toBe("paused");
    expect((await subs.resume("prj_1", "evs_1")).status).toBe("active");
    const rotated = await subs.rotateSecret("prj_1", "evs_1");
    expect(rotated).toEqual({ ...subscription, secretRotatedAt: "t3", signingSecret: "ocsk_new" });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/pause",
      "POST /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/resume",
      "POST /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/rotate-secret",
    ]);
  });

  it("lists, reads and replays deliveries", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/deliveries": () =>
        Response.json({ deliveries: [delivery], nextCursor: "dlv_1" }),
      "GET /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/deliveries/dlv_1": () =>
        Response.json({ delivery: { ...delivery, status: "delivered", deliveredAt: "t4", nextAttemptAt: undefined } }),
      "POST /api/managed-agents/projects/prj_1/event-subscriptions/evs_1/replay": () =>
        Response.json({ deliveries: [{ ...delivery, id: "dlv_2", attempt: 0, replayOf: "dlv_1", error: undefined, responseStatus: undefined }] }, { status: 202 }),
    });
    const deliveries = oc(api).projects.eventSubscriptions.deliveries;

    const page = await deliveries.list("prj_1", "evs_1", { status: "pending", sessionId: "ses_1", limit: 10 });
    expect(page).toEqual({ deliveries: [delivery], nextCursor: "dlv_1" });
    expect(api.last().path).toBe(
      "/api/managed-agents/projects/prj_1/event-subscriptions/evs_1/deliveries?status=pending&sessionId=ses_1&limit=10",
    );

    const one = await deliveries.get("prj_1", "evs_1", "dlv_1");
    expect(one.status).toBe("delivered");
    expect(one.deliveredAt).toBe("t4");

    const replayed = await deliveries.replay("prj_1", "evs_1", { sessionId: "ses_1", fromSequence: 40, toSequence: 45 });
    expect(api.last().body).toEqual({ sessionId: "ses_1", fromSequence: 40, toSequence: 45 });
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ id: "dlv_2", eventId: "event_1", replayOf: "dlv_1", status: "pending" });
  });

  it("only types replay selections the API accepts", () => {
    expectTypeOf<{ deliveryIds: string[] }>().toMatchTypeOf<ReplayEventDeliveriesSelection>();
    expectTypeOf<{ sessionId: string }>().toMatchTypeOf<ReplayEventDeliveriesSelection>();
    expectTypeOf<{ sessionId: string; fromSequence: number }>().toMatchTypeOf<ReplayEventDeliveriesSelection>();
    expectTypeOf<{ since: string }>().toMatchTypeOf<ReplayEventDeliveriesSelection>();
    expectTypeOf<{ until: string; limit: number }>().toMatchTypeOf<ReplayEventDeliveriesSelection>();
    expectTypeOf<{ since: string; until: string }>().toMatchTypeOf<ReplayEventDeliveriesSelection>();
    // The API answers 400 invalid_replay to these, so they must not compile.
    expectTypeOf<Record<never, never>>().not.toMatchTypeOf<ReplayEventDeliveriesSelection>();
    expectTypeOf<{ limit: number }>().not.toMatchTypeOf<ReplayEventDeliveriesSelection>();
    expectTypeOf<{ fromSequence: number }>().not.toMatchTypeOf<ReplayEventDeliveriesSelection>();
  });

  it("reads a session whose turn was delivered to an HTTPS destination", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1": () =>
        Response.json({
          id: "ses_1", agentId: "worker", deploymentId: "dep_1", status: "idle", createdAt: "t", updatedAt: "t",
          turns: [{
            id: "turn_1", input: "go", mode: "queue", status: "completed", createdAt: "t", updatedAt: "t",
            deliveries: [{ id: "evs_1:event_1", subscriptionId: "evs_1", eventId: "event_1", eventType: "turn.completed", destination: { type: "https", url: "https://receiver.example/oc" }, status: "delivered", attempt: 1, updatedAt: "t" }],
          }],
        }),
    });
    const session = await oc(api).sessions.get("ses_1");
    expect(session.turns[0]?.deliveries?.[0]?.destination).toEqual({ type: "https", url: "https://receiver.example/oc" });
  });
});

// ── 12: receiver-side verification ───────────────────────────────────────────

describe("verifyEventDelivery", () => {
  const secret = "ocsk_test_secret";
  const path = "/oc/events?env=dev";
  const envelope: EventDeliveryEnvelope = {
    schema: "opencomputer.event-delivery/v1",
    deliveryId: "dlv_1",
    eventId: "event_1",
    sequence: 42,
    occurredAt: "2026-09-25T00:00:00.000Z",
    projectId: "prj_1",
    environment: "development",
    agentId: "worker",
    deploymentId: "dep_1",
    sessionId: "ses_1",
    turnId: "turn_1",
    type: "turn.completed",
    data: { status: "completed", result: { text: "Done.", truncated: false } },
  };
  const body = JSON.stringify(envelope);
  const nowMs = Date.UTC(2026, 8, 25, 0, 0, 30);
  const timestamp = String(Math.floor(nowMs / 1000));

  async function signed(secrets: string[], ts = timestamp, method = "POST", p = path, b = body) {
    const entries = await Promise.all(secrets.map((s) => signEventDelivery(s, ts, method, p, b)));
    return new Headers({
      [EVENT_DELIVERY_HEADERS.timestamp]: ts,
      [EVENT_DELIVERY_HEADERS.signature]: entries.join(","),
    });
  }

  it("covers timestamp, method, path with query and the exact body", () => {
    expect(eventSigningInput("1", "post", path, body)).toBe(`1.POST.${path}.${body}`);
  });

  it("accepts a valid signature (acceptance 1)", async () => {
    const headers = await signed([secret]);
    expect(await verifyEventDelivery({ secret, headers, method: "POST", path, body, nowMs })).toBe(true);
    expect(headers.get(EVENT_DELIVERY_HEADERS.signature)).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(parseEventDelivery(body)).toEqual(envelope);
  });

  it("accepts plain header records, case-insensitively", async () => {
    const headers = await signed([secret]);
    const record = {
      "X-OC-Timestamp": headers.get(EVENT_DELIVERY_HEADERS.timestamp)!,
      "X-OC-Signature": headers.get(EVENT_DELIVERY_HEADERS.signature)!,
    };
    expect(await verifyEventDelivery({ secret, headers: record, method: "POST", path, body, nowMs })).toBe(true);
  });

  it("rejects a modified body, another path or method, the wrong secret, and a stale timestamp (acceptance 2)", async () => {
    const headers = await signed([secret]);
    const tampered = JSON.stringify({ ...envelope, data: { status: "failed" } });
    expect(await verifyEventDelivery({ secret, headers, method: "POST", path, body: tampered, nowMs })).toBe(false);
    expect(await verifyEventDelivery({ secret, headers, method: "POST", path: "/oc/events", body, nowMs })).toBe(false);
    expect(await verifyEventDelivery({ secret, headers, method: "PUT", path, body, nowMs })).toBe(false);
    expect(await verifyEventDelivery({ secret: "other", headers, method: "POST", path, body, nowMs })).toBe(false);
    expect(await verifyEventDelivery({ secret, headers, method: "POST", path, body, nowMs: nowMs + 5 * 60_000 + 1 })).toBe(false);
    expect(await verifyEventDelivery({ secret, headers, method: "POST", path, body, nowMs: nowMs - 5 * 60_000 - 1 })).toBe(false);
    expect(await verifyEventDelivery({ secret, headers: new Headers(), method: "POST", path, body, nowMs })).toBe(false);
    const garbage = new Headers(headers);
    garbage.set(EVENT_DELIVERY_HEADERS.signature, "v0=abc");
    expect(await verifyEventDelivery({ secret, headers: garbage, method: "POST", path, body, nowMs })).toBe(false);
  });

  it("accepts either secret during a rotation, on either side", async () => {
    const both = await signed(["ocsk_new", secret]);
    expect(await verifyEventDelivery({ secret, headers: both, method: "POST", path, body, nowMs })).toBe(true);
    expect(await verifyEventDelivery({ secret: "ocsk_new", headers: both, method: "POST", path, body, nowMs })).toBe(true);
    const onlyNew = await signed(["ocsk_new"]);
    expect(await verifyEventDelivery({ secret: [secret, "ocsk_new"], headers: onlyNew, method: "POST", path, body, nowMs })).toBe(true);
    expect(await verifyEventDelivery({ secret: [secret], headers: onlyNew, method: "POST", path, body, nowMs })).toBe(false);
  });

  it("parses only a v1 envelope", () => {
    expect(parseEventDelivery("not json")).toBeNull();
    expect(parseEventDelivery(JSON.stringify({ ...envelope, schema: "other/v2" }))).toBeNull();
    expect(parseEventDelivery(JSON.stringify({ ...envelope, sequence: "42" }))).toBeNull();
    expect(parseEventDelivery(JSON.stringify([envelope]))).toBeNull();
  });
});
