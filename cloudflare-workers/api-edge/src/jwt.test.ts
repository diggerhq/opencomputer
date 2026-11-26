import { base64url } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintAppToken, verifyAppToken } from "./app_auth";
import { mintSessionJWT, verifySessionJWT } from "./jwt";

// Made by the hand-written HS256 code jose replaced, at 2026-11-26T12:00:00Z
// with secret "fixture-secret": tokens already issued must still verify.
const OLD_APP_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJvcGVuc2FuZGJveC1hcHAiLCJzdWIiOiJ1c2VyXzAxSkFCQyIsIm9yZ19pZCI6Im9yZ18xIiwidXNlcl9pZCI6InVzZXJfMDFKQUJDIiwiZGV2IjoiZGV2X2FiYyIsImlhdCI6MTc5NTY5NDQwMCwiZXhwIjoxNzk1Njk1MzAwfQ.jme2LNYF573GijLZAe4mtFdDy2VJ0LOXXCqiPqt8gKk";
// The session cookie's construction, with a 7 day life and a non-ASCII wsid.
const OLD_SESSION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJvcGVuc2FuZGJveC1zZXNzaW9uIiwic3ViIjoidXNlcl8wMUpBQkMiLCJpYXQiOjE3OTU2OTQ0MDAsImV4cCI6MTc5NjI5OTIwMCwib3JnX2lkIjoib3JnXzEiLCJ1c2VyX2lkIjoidXNlcl8wMUpBQkMiLCJwbGFuIjoicHJvIiwid3NpZCI6IndzX8OpIn0.Eu8HQHatnLRnxAtaXX6zxCqO3-X04srFyTk2bpV46ps";
const SECRET = "fixture-secret";
const ISSUED = new Date("2026-11-26T12:00:00Z");

const b64 = (value: unknown) => base64url.encode(JSON.stringify(value));

describe("the edge's HS256 JWTs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ISSUED);
  });
  afterEach(() => vi.useRealTimers());

  it("verify an app token the old code made, and mint the same bytes", async () => {
    expect(await verifyAppToken(SECRET, OLD_APP_TOKEN)).toEqual({
      iss: "opensandbox-app",
      sub: "user_01JABC",
      org_id: "org_1",
      user_id: "user_01JABC",
      dev: "dev_abc",
      iat: 1795694400,
      exp: 1795695300,
    });
    expect(await mintAppToken(SECRET, "org_1", "user_01JABC", "dev_abc")).toBe(OLD_APP_TOKEN);
  });

  it("verify a session cookie the old code made", async () => {
    expect(await verifySessionJWT(SECRET, OLD_SESSION_TOKEN)).toMatchObject({
      iss: "opensandbox-session",
      org_id: "org_1",
      user_id: "user_01JABC",
      plan: "pro",
      wsid: "ws_é",
    });
  });

  it("refuse an expired, tampered, foreign or unsigned token", async () => {
    expect(await verifyAppToken("other-secret", OLD_APP_TOKEN)).toBeNull();
    expect(await verifyAppToken("", OLD_APP_TOKEN)).toBeNull();
    const [header, , signature] = OLD_APP_TOKEN.split(".");
    expect(await verifyAppToken(SECRET, `${header}.${b64({ iss: "opensandbox-app", dev: "dev_x", org_id: "o", user_id: "u", exp: 2e9 })}.${signature}`)).toBeNull();
    expect(await verifyAppToken(SECRET, `${b64({ alg: "none", typ: "JWT" })}.${OLD_APP_TOKEN.split(".")[1]}.`)).toBeNull();
    // Each issuer's verifier refuses the other's token.
    expect(await verifyAppToken(SECRET, OLD_SESSION_TOKEN)).toBeNull();
    expect(await verifySessionJWT(SECRET, OLD_APP_TOKEN)).toBeNull();
    vi.setSystemTime(new Date(ISSUED.getTime() + 15 * 60_000 + 1_000));
    expect(await verifyAppToken(SECRET, OLD_APP_TOKEN)).toBeNull();
  });

  it("round-trip a new session cookie", async () => {
    const token = await mintSessionJWT(SECRET, "org_1", "user_1", "free", "ws_1");
    expect(JSON.parse(new TextDecoder().decode(base64url.decode(token.split(".")[0]!)))).toEqual({ alg: "HS256", typ: "JWT" });
    expect(await verifySessionJWT(SECRET, token)).toMatchObject({ org_id: "org_1", user_id: "user_1", plan: "free", wsid: "ws_1", exp: 1795694400 + 8 * 3600 });
  });
});
