import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertGoogleScopes,
  exchangeGoogleCode,
  GMAIL_SCOPES,
  googleAuthorizationUrl,
  refreshGoogleCredential,
  requestGoogleApi,
  resolveGoogleIdentity,
} from "../src/connections/google.js";

describe("Google connection adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a PKCE authorization URL", () => {
    const url = new URL(
      googleAuthorizationUrl({
        config: { clientId: "client-id" },
        redirectUri: "http://127.0.0.1:3456/oauth/callback",
        scopes: ["openid", "email"],
        state: "state",
        codeChallenge: "challenge",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("exchanges, refreshes, identifies, and calls Gmail", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      signal: AbortSignal | null;
    }> = [];
    const responses = [
      {
        access_token: "access-one",
        refresh_token: "refresh-one",
        token_type: "Bearer",
        expires_in: 0,
        scope:
          "openid email https://www.googleapis.com/auth/gmail.modify",
      },
      { sub: "google-user", email: "user@example.com" },
      {
        access_token: "access-two",
        token_type: "Bearer",
        expires_in: 3600,
      },
      { messages: [{ id: "message-one" }] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          signal: init?.signal instanceof AbortSignal ? init.signal : null,
        });
        return Response.json(responses.shift());
      }),
    );

    const credential = await exchangeGoogleCode({
      config: { clientId: "client-id" },
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1:3456/oauth/callback",
    });
    await expect(resolveGoogleIdentity(credential)).resolves.toMatchObject({
      id: "google-user",
      email: "user@example.com",
    });
    const refreshed = await refreshGoogleCredential(
      { clientId: "client-id" },
      credential,
    );
    expect(refreshed.refreshToken).toBe("refresh-one");
    await expect(
      requestGoogleApi(refreshed, {
        service: "gmail",
        path: "/gmail/v1/users/me/messages",
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: '{"messages":[{"id":"message-one"}]}',
    });
    expect(requests[3]).toEqual({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      authorization: "Bearer access-two",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects unsupported services and absolute paths", async () => {
    const credential = {
      accessToken: "access",
      tokenType: "Bearer",
      expiresAt: Date.now() + 60_000,
      scopes: [],
    };
    await expect(
      requestGoogleApi(credential, {
        service: "unknown",
        path: "/v1/data",
      }),
    ).rejects.toThrow("Unsupported Google service");
    await expect(
      requestGoogleApi(credential, {
        service: "gmail",
        path: "https://evil.example/data",
      }),
    ).rejects.toThrow("must be relative");
  });

  it("rejects OAuth grants that omit Gmail access", () => {
    expect(() =>
      assertGoogleScopes(
        {
          accessToken: "access",
          tokenType: "Bearer",
          expiresAt: Date.now() + 60_000,
          scopes: [
            "openid",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
        },
        [...GMAIL_SCOPES],
      ),
    ).toThrow("gmail.modify");
  });

  it("caps provider request and response bodies", async () => {
    const credential = {
      accessToken: "access",
      tokenType: "Bearer",
      expiresAt: Date.now() + 60_000,
      scopes: [],
    };
    await expect(
      requestGoogleApi(credential, {
        service: "gmail",
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
        body: "x".repeat(4_000_001),
      }),
    ).rejects.toThrow("request body exceeded");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const chunk = new Uint8Array(2_000_001);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.close();
            },
          }),
        );
      }),
    );
    await expect(
      requestGoogleApi(credential, {
        service: "gmail",
        path: "/gmail/v1/users/me/messages",
      }),
    ).rejects.toThrow("response exceeded");
  });
});
