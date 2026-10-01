import { OpenComputer } from "@opencomputer/sdk/agents";
import type { Env } from "./env.js";

export const CREDENTIAL_NAME = "ChatGPT";

export interface Identity {
  orgId: string;
  orgName: string;
  userId: string | null;
  email: string;
}

export interface DeviceLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DeviceExchange =
  | { status: "pending"; retryAfter: number }
  | { status: "authorized"; apiKey: string }
  | { status: "denied" | "expired" | "unavailable"; message: string };

/**
 * The OpenComputer API calls the connect flow makes. Requests go to the configured origin only,
 * redirects are never followed, and the user's IP is forwarded over the service binding so the
 * edge's login rate limits stay per user.
 */
export class OpenComputerAccounts {
  constructor(
    private readonly env: Pick<Env, "OPENCOMPUTER_API_URL" | "API_EDGE">,
    private readonly clientIp?: string | null,
  ) {}

  private call(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const url = new URL(path, this.env.OPENCOMPUTER_API_URL);
    const headers = new Headers(init.headers);
    if (this.env.API_EDGE) {
      if (this.clientIp) headers.set("CF-Connecting-IP", this.clientIp);
      return this.env.API_EDGE.fetch(new Request(url, { ...init, headers, redirect: "manual" }));
    }
    return fetch(url, { ...init, headers, redirect: "manual" });
  }

  async startDeviceLogin(): Promise<DeviceLogin | null> {
    const response = await this.call("/auth/cli/device", { method: "POST" });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.device_code !== "string" ||
      typeof body.user_code !== "string" ||
      typeof body.verification_uri_complete !== "string" ||
      !body.verification_uri_complete.startsWith("https://") ||
      typeof body.expires_in !== "number" ||
      body.expires_in <= 0
    ) {
      return null;
    }
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri_complete,
      expiresIn: body.expires_in,
      interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
    };
  }

  async exchangeDeviceLogin(deviceCode: string): Promise<DeviceExchange> {
    const response = await this.call("/auth/cli/device/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode, credential_name: CREDENTIAL_NAME }),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 202) {
      const retryAfter = typeof body?.retry_after === "number" ? body.retry_after : 5;
      return { status: "pending", retryAfter };
    }
    if (response.ok && body?.status === "authorized") {
      const credential = body.credential as Record<string, unknown> | undefined;
      if (typeof credential?.key === "string" && credential.key.startsWith("osb_")) {
        return { status: "authorized", apiKey: credential.key };
      }
    }
    if (response.status === 403) return { status: "denied", message: "Sign-in was declined." };
    if (response.status === 410) return { status: "expired", message: "Sign-in expired. Start again." };
    if (response.status === 429) return { status: "pending", retryAfter: 10 };
    return { status: "unavailable", message: "OpenComputer sign-in is unavailable right now." };
  }

  /** `null` when the key is not a working OpenComputer key. */
  async whoami(apiKey: string): Promise<Identity | null> {
    const response = await this.call("/api/whoami", { method: "GET", headers: { "x-api-key": apiKey } });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    // Keys made outside a user login (scoped or service keys) have no user.
    if (!body || typeof body.org_id !== "string" || body.org_id.length === 0) return null;
    return {
      orgId: body.org_id,
      orgName: typeof body.org_name === "string" ? body.org_name : "",
      userId: typeof body.user_id === "string" && body.user_id.length > 0 ? body.user_id : null,
      email: typeof body.email === "string" ? body.email : "",
    };
  }
}

export function agentsClient(env: Pick<Env, "OPENCOMPUTER_API_URL" | "API_EDGE">, apiKey: string): OpenComputer {
  const binding = env.API_EDGE;
  return new OpenComputer({
    apiKey,
    baseUrl: new URL("/api/managed-agents", env.OPENCOMPUTER_API_URL).toString(),
    fetch: binding ? (input, init) => binding.fetch(new Request(input, init)) : undefined,
  });
}
