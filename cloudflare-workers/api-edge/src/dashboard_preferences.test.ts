import { describe, expect, it } from "vitest";
import { handleDashboard, type DashboardEnv } from "./dashboard";

const secret = "dashboard-preferences-test-secret";
const userID = "user-1";
const orgID = "org-1";

function b64url(value: string | ArrayBuffer): string {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sessionToken(): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: userID,
      iss: "opensandbox-session",
      org_id: orgID,
      user_id: userID,
      plan: "free",
      iat: 1,
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

function testEnv(durableSessionsEnabled = false) {
  const preferences = {
    durableSessionsEnabled,
    infrastructureEnabled: true,
  };

  class Statement {
    private args: unknown[] = [];

    constructor(private readonly sql: string) {}

    bind(...args: unknown[]) {
      this.args = args;
      return this;
    }

    async first<T>(): Promise<T | null> {
      if (this.sql.includes("FROM users WHERE id")) {
        return {
          id: userID,
          email: "person@example.com",
          name: "Person",
          workos_user_id: "workos-1",
          durable_sessions_enabled: Number(preferences.durableSessionsEnabled),
          infrastructure_enabled: Number(preferences.infrastructureEnabled),
        } as T;
      }
      return null;
    }

    async all<T>() {
      if (this.sql.includes("JOIN org_memberships")) {
        return {
          results: [{ id: orgID, name: "Personal", is_personal: 1 }] as T[],
        };
      }
      return { results: [] as T[] };
    }

    async run() {
      if (this.sql.includes("UPDATE users")) {
        if (this.args[0] !== null) {
          preferences.infrastructureEnabled = this.args[0] === 1;
        }
      }
      return {};
    }
  }

  const env = {
    SESSION_JWT_SECRET: secret,
    OPENCOMPUTER_DB: {
      prepare: (sql: string) => new Statement(sql),
    },
  } as unknown as DashboardEnv;

  return { env, preferences };
}

async function request(body: unknown): Promise<Request> {
  return new Request("https://app.test/api/dashboard/me/preferences", {
    method: "PUT",
    headers: {
      cookie: `oc_session=${await sessionToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function meRequest(): Promise<Request> {
  return new Request("https://app.test/api/dashboard/me", {
    headers: { cookie: `oc_session=${await sessionToken()}` },
  });
}

describe("dashboard navigation preferences", () => {
  it("reports the administrator-managed durable session navigation state", async () => {
    const { env } = testEnv(true);
    const response = await handleDashboard(
      await meRequest(),
      env,
      {} as ExecutionContext,
      "/api/dashboard/me",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      durableSessionsEnabled: true,
      infrastructureEnabled: true,
    });
  });

  it("updates one preference without changing the other", async () => {
    const { env, preferences } = testEnv();
    const response = await handleDashboard(
      await request({ infrastructureEnabled: false }),
      env,
      {} as ExecutionContext,
      "/api/dashboard/me/preferences",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      durableSessionsEnabled: false,
      infrastructureEnabled: false,
    });
    expect(preferences).toEqual({
      durableSessionsEnabled: false,
      infrastructureEnabled: false,
    });
  });

  it.each([true, false])(
    "rejects attempts to set administrator-managed durable session navigation to %s",
    async (durableSessionsEnabled) => {
      const { env, preferences } = testEnv();
      const response = await handleDashboard(
        await request({ durableSessionsEnabled }),
        env,
        {} as ExecutionContext,
        "/api/dashboard/me/preferences",
      );

      expect(response.status).toBe(403);
      expect(preferences.durableSessionsEnabled).toBe(false);
    },
  );

  it("rejects non-boolean preferences", async () => {
    const { env, preferences } = testEnv();
    const response = await handleDashboard(
      await request({ infrastructureEnabled: "yes" }),
      env,
      {} as ExecutionContext,
      "/api/dashboard/me/preferences",
    );

    expect(response.status).toBe(400);
    expect(preferences.infrastructureEnabled).toBe(true);
  });
});
