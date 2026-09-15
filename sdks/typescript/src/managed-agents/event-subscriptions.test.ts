import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CreateEventSubscriptionBody,
  EventInput,
  EventSubscription,
  OutcomeEvent,
  TurnOutcomeDelivery,
} from "./index.js";

// Types only: what has to compile for a caller to type a subscription
// request, its response, a turn's deliveries, and the delivered input.
describe("event subscription types", () => {
  it("shape a subscription request and its response", () => {
    const body: CreateEventSubscriptionBody = {
      agentId: "worker",
      events: ["turn.completed", "turn.failed"],
      destination: { type: "session", sessionId: "ses_coordinator" },
      environment: "development",
    };
    const subscription: EventSubscription = {
      id: "evs_1",
      projectId: "prj_1",
      ...body,
      createdAt: "2026-09-10T12:00:00.000Z",
    };
    expectTypeOf(subscription.destination.type).toEqualTypeOf<"session">();
    expect(subscription.events).toContain("turn.failed");
    // @ts-expect-error a public HTTPS destination is not a destination type.
    const https: CreateEventSubscriptionBody["destination"] = { type: "https", url: "https://example.com" };
    expect(https.type).toBe("https");
  });

  it("narrow a delivered outcome from the agent's input", () => {
    const event: OutcomeEvent = {
      id: "event_9",
      type: "turn.completed",
      sessionId: "ses_worker",
      turnId: "turn-1",
      agentId: "worker",
      occurredAt: "2026-09-10T12:00:00.000Z",
      result: { text: "Done.", truncated: false },
    };
    const input: EventInput = { source: "event", event };
    expectTypeOf(input.source).toEqualTypeOf<"event">();
    expect(input.event.result?.text).toBe("Done.");
    const delivery: TurnOutcomeDelivery = {
      id: "evs_1:event_9",
      subscriptionId: "evs_1",
      eventId: "event_9",
      eventType: "turn.completed",
      destination: { type: "session", sessionId: "ses_coordinator" },
      status: "delivered",
      attempt: 1,
      receipt: { sessionId: "ses_coordinator", turnId: "turn-7" },
      updatedAt: "2026-09-10T12:01:01.000Z",
    };
    expectTypeOf(delivery.error).toEqualTypeOf<
      "subscription_unavailable" | "target_missing" | "target_ended" | "delivery_failed" | undefined
    >();
    expect(delivery.receipt?.turnId).toBe("turn-7");
  });
});
