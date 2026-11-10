import { describe, expect, it } from "vitest";

import { TicketTooLongError, mintTicket as mintForRoute, validateTicketRequest } from "../src/computer/tickets.js";
import { TICKET_MAX_LENGTH, TICKET_TTL_MS, mintTicket, verifyTicket } from "../src/wire/ticket.js";

/** Work 084: ticket v1, minted for `POST /tickets` and verified by the wire Worker. */

const KEY = "test-wire-ticket-key";
const NOW = 1_800_000_000_000;
const INPUT = {
  org: "org_0123456789ab",
  member: "usr_0123456789ab",
  computer: "cmp_0123456789ab",
  tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef",
  keyId: "key_0123456789ab",
  client: "my-dashboard/1.4.0",
  scope: { sessionIds: ["cs_7f3a9k2m4q8r1t6v"], readOnly: true },
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => `cs_${String(i).padStart(16, "0")}`);

describe("ticket v1", () => {
  it("round-trips, and is good for exactly 10 minutes", async () => {
    const token = await mintTicket(KEY, INPUT, NOW);
    expect(token).toMatch(/^tk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyTicket(KEY, token, NOW)).toEqual({ v: 1, ...INPUT, exp: NOW + TICKET_TTL_MS });
    expect(await verifyTicket(KEY, token, NOW + TICKET_TTL_MS - 1)).toBeDefined();
    expect(await verifyTicket(KEY, token, NOW + TICKET_TTL_MS)).toBeUndefined();
  });

  it("refuses a tampered payload or MAC, another key, and garbage", async () => {
    const token = await mintTicket(KEY, INPUT, NOW);
    const [body, mac] = token.split(".") as [string, string];
    const widened = `tk_${btoa(JSON.stringify({ v: 1, ...INPUT, scope: {}, exp: NOW + TICKET_TTL_MS })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    expect(await verifyTicket(KEY, `${widened}.${mac}`, NOW)).toBeUndefined();
    expect(await verifyTicket(KEY, `${body}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`, NOW)).toBeUndefined();
    expect(await verifyTicket("another-key", token, NOW)).toBeUndefined();
    for (const bad of ["", "tk_", "tk_.", token.slice(3), `${token}.x`, null, undefined]) expect(await verifyTicket(KEY, bad, NOW)).toBeUndefined();
  });

  it("is at most 1024 characters: 20 sessions with short ids fit, a longer one is refused both ways", async () => {
    const full = await mintTicket(KEY, { ...INPUT, client: "opc/0.1.0", scope: { sessionIds: ids(20), readOnly: true } }, NOW);
    expect(full.length).toBeLessThanOrEqual(TICKET_MAX_LENGTH);
    // The format is calvin's and the limit is the vectors': 20 sessions and a 64-character client do not fit (the route answers 400).
    await expect(mintTicket(KEY, { ...INPUT, client: "x".repeat(64), scope: { sessionIds: ids(20), readOnly: true } }, NOW)).rejects.toBeInstanceOf(TicketTooLongError);
    expect(await verifyTicket(KEY, `${full}${"A".repeat(TICKET_MAX_LENGTH)}`, NOW)).toBeUndefined();
  });

  it("refuses more than 20 sessions or a malformed id even when signed", async () => {
    expect(await verifyTicket(KEY, await mintTicket(KEY, { ...INPUT, scope: { sessionIds: ids(21) } }, NOW), NOW)).toBeUndefined();
    expect(await verifyTicket(KEY, await mintTicket(KEY, { ...INPUT, scope: { sessionIds: ["cs_bad"] } }, NOW), NOW)).toBeUndefined();
  });
});

describe("POST /tickets body and response", () => {
  it("defaults the client to the User-Agent and accepts an empty body", () => {
    expect(validateTicketRequest(undefined, "Mozilla/5.0 | evil\u0001")).toEqual({ ok: true, value: { client: "Mozilla/5.0  evil" } });
    expect(validateTicketRequest({}, "x".repeat(100))).toEqual({ ok: true, value: { client: "x".repeat(64) } });
    expect(validateTicketRequest({ client: "acme/2.0", sessionIds: ["cs_7f3a9k2m4q8r1t6v", "cs_7f3a9k2m4q8r1t6v"], readOnly: true }, "ua")).toEqual({
      ok: true,
      value: { client: "acme/2.0", sessionIds: ["cs_7f3a9k2m4q8r1t6v"], readOnly: true },
    });
  });

  it("names the field at fault", () => {
    const fields = (body: unknown) => {
      const result = validateTicketRequest(body);
      return result.ok ? [] : result.errors.map((error) => error.field);
    };
    expect(fields({ sessionIds: ["cs_7f3a9k2m4q8r1t6v", "nope"] })).toEqual(["sessionIds[1]"]);
    expect(fields({ sessionIds: ids(21) })).toEqual(["sessionIds"]);
    expect(fields({ sessionIds: "cs_7f3a9k2m4q8r1t6v" })).toEqual(["sessionIds"]);
    expect(fields({ readOnly: "yes" })).toEqual(["readOnly"]);
    expect(fields({ client: "x".repeat(65) })).toEqual(["client"]);
    expect(fields({ client: "a|b" })).toEqual(["client"]);
    expect(fields({ scope: {} })).toEqual(["scope"]);
    expect(fields([])).toEqual([""]);
  });

  it("mints the documented response", async () => {
    const { scope: _scope, ...who } = INPUT;
    const ticket = await mintForRoute({ WIRE_TICKET_KEY: KEY }, { ...who, sessionIds: ["cs_7f3a9k2m4q8r1t6v"], readOnly: true }, NOW);
    expect(ticket).toEqual({
      token: expect.stringMatching(/^tk_/),
      url: "wss://wire.opencomputer.dev/v1",
      expiresAt: new Date(NOW + 600_000).toISOString(),
      expiresInMs: 600_000,
    });
    expect((await verifyTicket(KEY, ticket.token, NOW))?.scope).toEqual({ sessionIds: ["cs_7f3a9k2m4q8r1t6v"], readOnly: true });
    expect((await mintForRoute({ WIRE_TICKET_KEY: KEY, WIRE_PUBLIC_URL: "wss://wire.example/v1" }, { ...who }, NOW)).url).toBe("wss://wire.example/v1");
    await expect(mintForRoute({}, { ...who }, NOW)).rejects.toThrow("WIRE_TICKET_KEY");
  });
});
