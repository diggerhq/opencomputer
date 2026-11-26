import { describe, expect, it } from "vitest";

import { signPreview } from "../src/previews/auth.js";
import { WIRE_SIGNATURE_TTL_MS, encodeWireScope, signWireAuth } from "../src/wire/auth.js";
import { base64Url } from "../src/wire/crypto.js";
import { TICKET_TTL_MS, type TicketClaims, mintTicket, ticketMacKeyBytes, verifyTicket } from "../src/wire/ticket.js";
import vectors from "./fixtures/calvin/wire-auth-vectors.json" with { type: "json" };

/**
 * Work 084: calvin's published vectors (calvin scripts/wire-auth-vectors.mjs
 * from src/signed-header.ts), reproduced byte for byte. blue signs X-Wire-*,
 * mints and verifies tickets; calvin's relay verifies X-Wire-*.
 */

/** The relay's acceptance rule (calvin verifyWire), mirrored to show what blue signs passes it. */
const RELAY_SKEW_MS = 30_000;

type Headers5 = Record<string, string | undefined>;

async function resign(key: string, headers: Headers5): Promise<string | undefined> {
  const [exp] = (headers["x-wire-auth"] ?? "").split(".");
  if (!headers["x-wire-member"] || !/^\d{13}$/.test(exp ?? "")) return undefined;
  const scope = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(headers["x-wire-scope"]!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  const signed = await signWireAuth(key, { member: headers["x-wire-member"]!, keyId: headers["x-wire-key"]!, client: headers["x-wire-client"]!, scope, exp: Number(exp) });
  return signed["x-wire-auth"];
}

describe("calvin's wire-auth vectors", () => {
  it("signs the preview case as blue always has", async () => {
    expect(await signPreview(vectors.preview.key, vectors.preview.port, vectors.preview.now)).toBe(vectors.preview.header);
  });

  for (const [index, c] of vectors.wire.cases.entries()) {
    it(`signs X-Wire-* case ${index} byte for byte`, async () => {
      expect(c.claims.exp).toBe(c.now + WIRE_SIGNATURE_TTL_MS);
      expect(encodeWireScope(c.claims.scope)).toBe(c.headers["x-wire-scope"]);
      expect(atob(c.headers["x-wire-scope"].replace(/-/g, "+").replace(/_/g, "/"))).toBe(c.scopeJson);
      expect(await signWireAuth(vectors.wire.key, c.claims)).toEqual(c.headers);
    });
  }

  for (const r of vectors.wire.refuse) {
    it(`never signs what the relay refuses: ${r.why}`, async () => {
      const headers = r.headers as Headers5;
      const auth = headers["x-wire-auth"]!;
      const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(auth);
      if (!match || !headers["x-wire-member"]) {
        // Malformed, a ticket in its place or a missing member: nothing blue signs looks like it.
        expect(match && headers["x-wire-member"]).toBeFalsy();
        return;
      }
      const exp = Number(match[1]);
      const inWindow = exp > r.now && exp <= r.now + WIRE_SIGNATURE_TTL_MS + RELAY_SKEW_MS;
      const macOk = (await resign((r as { key?: string }).key ?? vectors.wire.key, headers)) === auth;
      expect(inWindow && macOk).toBe(false);
    });
  }

  it("derives the ticket MAC key with HKDF", async () => {
    expect(base64Url(await ticketMacKeyBytes(vectors.ticket.wireTicketKey))).toBe(vectors.ticket.macKey);
  });

  for (const [index, c] of vectors.ticket.cases.entries()) {
    it(`mints and verifies ticket case ${index} byte for byte`, async () => {
      const { v: _v, exp, ...input } = c.claims as TicketClaims;
      expect(exp).toBe(c.now + TICKET_TTL_MS);
      expect(await mintTicket(vectors.ticket.wireTicketKey, input, c.now)).toBe(c.ticket);
      expect(await verifyTicket(vectors.ticket.wireTicketKey, c.ticket, c.now)).toEqual(c.claims);
    });
  }

  for (const r of vectors.ticket.refuse) {
    it(`refuses a ticket: ${r.why}`, async () => {
      expect(await verifyTicket(vectors.ticket.wireTicketKey, r.ticket, r.now)).toBeUndefined();
    });
  }
});
