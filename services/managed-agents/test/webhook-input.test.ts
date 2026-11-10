import { describe, expect, it } from "vitest";

import {
  normalizeWebhookInput,
  parseWebhookIdentitySource,
  webhookDeliveryIdentity,
} from "../src/edge/webhook-input.js";

describe("normalizeWebhookInput", () => {
  it("keeps text and payload when either key is present", () => {
    expect(normalizeWebhookInput({ text: "Run it" })).toEqual({
      ok: true,
      input: { text: "Run it" },
    });
    expect(
      normalizeWebhookInput({ text: "Run it", payload: { mode: "hygiene" } }),
    ).toEqual({ ok: true, input: { text: "Run it", payload: { mode: "hygiene" } } });
    expect(normalizeWebhookInput({ payload: null })).toEqual({
      ok: true,
      input: { payload: null },
    });
  });

  it("admits a provider body whole as payload", () => {
    const sentry = {
      action: "triggered",
      data: { event: { event_id: "a".repeat(32) } },
      installation: { uuid: "inst" },
    };
    expect(normalizeWebhookInput(sentry)).toEqual({
      ok: true,
      input: { payload: sentry },
    });
  });

  it("rejects non-objects, non-string text, and empty input", () => {
    expect(normalizeWebhookInput(null).ok).toBe(false);
    expect(normalizeWebhookInput([1, 2]).ok).toBe(false);
    expect(normalizeWebhookInput({ text: 5 })).toEqual({
      ok: false,
      message: "text must be a string",
    });
    expect(normalizeWebhookInput({ text: "   " })).toEqual({
      ok: false,
      message: "Expected text or payload in a JSON object",
    });
    expect(normalizeWebhookInput({ text: "x".repeat(64 * 1024 + 1) })).toEqual({
      ok: false,
      message: "text cannot exceed 64 KiB",
    });
  });
});

describe("parseWebhookIdentitySource", () => {
  it("accepts header and body sources and normalizes header names", () => {
    expect(parseWebhookIdentitySource(" header:X-GitHub-Delivery ")).toBe("header:x-github-delivery");
    expect(parseWebhookIdentitySource("body:/data/event/event_id")).toBe("body:/data/event/event_id");
    expect(parseWebhookIdentitySource("body:/a~1b/~0c/0")).toBe("body:/a~1b/~0c/0");
  });

  it("keeps a body pointer verbatim, since whitespace is significant in a JSON key", () => {
    expect(parseWebhookIdentitySource("body:/id ")).toBe("body:/id ");
    expect(parseWebhookIdentitySource("  body:/ spaced /key")).toBe("body:/ spaced /key");
  });

  it("rejects headers the public edge sets or strips, so a configured source can always be read", () => {
    for (const name of ["x-request-id", "X-OC-Delivery-Id", "cf-ray", "x-forwarded-for", "authorization", "cookie", "idempotency-key", "x-api-key"]) {
      expect(() => parseWebhookIdentitySource(`header:${name}`)).toThrow(/sets or strips/);
    }
  });

  it("rejects anything else", () => {
    for (const value of ["", "sentry", "header:", "header:bad header", "body:", "body:data/event", "body:/x~2", "query:id"]) {
      expect(() => parseWebhookIdentitySource(value)).toThrow();
    }
  });
});

describe("webhookDeliveryIdentity", () => {
  it("prefers an explicit Idempotency-Key, which is never derived", async () => {
    await expect(
      webhookDeliveryIdentity(
        new Headers({ "request-id": "r1", "idempotency-key": " k1 " }),
        {},
        "header:request-id",
      ),
    ).resolves.toEqual({ key: "k1", derived: false });
  });

  it("is undefined without a key and without a configured source", async () => {
    await expect(webhookDeliveryIdentity(new Headers({ "request-id": "r1" }), {})).resolves.toBeUndefined();
  });

  it("reads a configured header source", async () => {
    await expect(
      webhookDeliveryIdentity(new Headers({ "x-github-delivery": "d1" }), {}, "header:x-github-delivery"),
    ).resolves.toEqual({ key: "header:x-github-delivery=d1", derived: true });
    await expect(
      webhookDeliveryIdentity(new Headers(), {}, "header:x-github-delivery"),
    ).resolves.toBeUndefined();
  });

  it("reads a configured body pointer, stable across a provider's retries", async () => {
    const body = { action: "triggered", data: { event: { event_id: "a".repeat(32) } } };
    const first = await webhookDeliveryIdentity(new Headers({ "request-id": "attempt-1" }), body, "body:/data/event/event_id");
    const retry = await webhookDeliveryIdentity(new Headers({ "request-id": "attempt-2" }), body, "body:/data/event/event_id");
    expect(first).toEqual({ key: `body:/data/event/event_id=${"a".repeat(32)}`, derived: true });
    expect(retry).toEqual(first);
    await expect(
      webhookDeliveryIdentity(new Headers(), { id: 42 }, "body:/id"),
    ).resolves.toEqual({ key: "body:/id=42", derived: true });
    await expect(
      webhookDeliveryIdentity(new Headers(), { items: [{ id: "x" }] }, "body:/items/0/id"),
    ).resolves.toEqual({ key: "body:/items/0/id=x", derived: true });
    await expect(
      webhookDeliveryIdentity(new Headers(), { "a/b": { "~c": "esc" } }, "body:/a~1b/~0c"),
    ).resolves.toEqual({ key: "body:/a~1b/~0c=esc", derived: true });
    // A trailing space names a different key than the trimmed one.
    await expect(
      webhookDeliveryIdentity(new Headers(), { "id ": "event-A", id: "shared" }, "body:/id "),
    ).resolves.toEqual({ key: "body:/id =event-A", derived: true });
    // Array indices follow RFC 6901: no leading zeros.
    await expect(
      webhookDeliveryIdentity(new Headers(), { items: ["x", "y"] }, "body:/items/01"),
    ).resolves.toBeUndefined();
  });

  it("is undefined when the pointer misses or the value is not a scalar id", async () => {
    for (const body of [{}, { data: null }, { data: { event: { event_id: "" } } }, { data: { event: { event_id: {} } } }, { data: [] }]) {
      await expect(webhookDeliveryIdentity(new Headers(), body, "body:/data/event/event_id")).resolves.toBeUndefined();
    }
  });

  it("bounds a derived key regardless of value length", async () => {
    const identity = await webhookDeliveryIdentity(new Headers(), { id: "r".repeat(300) }, "body:/id");
    expect(identity?.derived).toBe(true);
    expect(identity?.key).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(webhookDeliveryIdentity(new Headers(), { id: "r".repeat(300) }, "body:/id")).resolves.toEqual(identity);
  });
});
