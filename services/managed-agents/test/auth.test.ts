import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  authenticateRequest,
  isAcceptedWorkOsIssuer,
  type ManagedAgentAuthEnv,
} from "../src/edge/auth.js";
import { renderConnectionCallback } from "../src/edge/connection-callback.js";
import { isComputerGrantRoute } from "../src/edge/computer-principal.js";

const env: ManagedAgentAuthEnv = {
  BLUE_ACCOUNT_ID: "test",
  BLUE_ENVIRONMENT: "production",
  BLUE_WORKOS_CLIENT_ID: "client_test",
  BLUE_WORKOS_ISSUER: "https://auth.example.com",
};

describe("WorkOS issuer validation", () => {
  it("accepts standard, custom, and application-scoped issuers", () => {
    expect(isAcceptedWorkOsIssuer("https://api.workos.com", env)).toBe(true);
    expect(
      isAcceptedWorkOsIssuer(
        "https://api.workos.com/user_management/client_test",
        env,
      ),
    ).toBe(true);
    expect(isAcceptedWorkOsIssuer("https://auth.example.com/", env)).toBe(true);
  });

  it("rejects issuers for another application", () => {
    expect(
      isAcceptedWorkOsIssuer(
        "https://api.workos.com/user_management/client_other",
        env,
      ),
    ).toBe(false);
    expect(isAcceptedWorkOsIssuer("https://auth.example.com.evil", env)).toBe(
      false,
    );
  });
});

describe("OpenComputer managed-agent assertions", () => {
  it("maps a valid short-lived assertion to the OpenComputer organization", async () => {
    const secret = "test-managed-agent-secret-at-least-32-bytes";
    const token = await new SignJWT({
      org_id: "org_test",
      user_id: "user_test",
      role: "admin",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("opencomputer-edge")
      .setAudience("managedagents")
      .setSubject("org_test")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(new TextEncoder().encode(secret));
    const request = new Request("https://managedagents.test/v1/agents", {
      headers: { "x-opencomputer-agent-token": token },
    });
    const identity = await authenticateRequest(
      request,
      {
        BLUE_ACCOUNT_ID: "unused",
        BLUE_ENVIRONMENT: "production",
        OC_MANAGED_AGENTS_SECRET: secret,
      },
      new URL(request.url),
    );

    expect(identity).toEqual({
      kind: "user",
      accountId: "org_test",
      organizationId: "org_test",
      userId: "user_test",
      role: "admin",
    });
  });

  it("carries the computer principal and its session, and nothing else", async () => {
    const secret = "test-managed-agent-secret-at-least-32-bytes";
    const assertion = (claims: Record<string, unknown>) =>
      new SignJWT({ org_id: "org_test", user_id: "computer", ...claims })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("opencomputer-edge")
        .setAudience("managedagents")
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(new TextEncoder().encode(secret));
    const authenticate = async (claims: Record<string, unknown>) => {
      const request = new Request("https://managedagents.test/v1/agents", {
        headers: { "x-opencomputer-agent-token": await assertion(claims) },
      });
      return authenticateRequest(
        request,
        { BLUE_ACCOUNT_ID: "unused", BLUE_ENVIRONMENT: "production", OC_MANAGED_AGENTS_SECRET: secret },
        new URL(request.url),
      );
    };

    expect(await authenticate({ principal: "computer", session_key: "T1:C1:100.1" })).toEqual({
      kind: "user",
      accountId: "org_test",
      organizationId: "org_test",
      userId: "computer",
      principal: "computer",
      sessionKey: "T1:C1:100.1",
    });
    expect(await authenticate({ principal: "computer" })).toMatchObject({ principal: "computer" });
    expect(await authenticate({ principal: "admin" })).toBeNull();
    expect(await authenticate({ session_key: "T1:C1:100.1" })).toBeNull();
    expect(await authenticate({ principal: "computer", session_key: 7 })).toBeNull();
  });

  it("rejects assertions for a different audience", async () => {
    const secret = "test-managed-agent-secret-at-least-32-bytes";
    const token = await new SignJWT({ org_id: "org_test" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("opencomputer-edge")
      .setAudience("somewhere-else")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(new TextEncoder().encode(secret));
    const request = new Request("https://managedagents.test/v1/agents", {
      headers: { "x-opencomputer-agent-token": token },
    });

    expect(
      await authenticateRequest(
        request,
        {
          BLUE_ACCOUNT_ID: "unused",
          BLUE_ENVIRONMENT: "production",
          OC_MANAGED_AGENTS_SECRET: secret,
        },
        new URL(request.url),
      ),
    ).toBeNull();
  });

  it("disables historical customer auth in managed-only mode", async () => {
    const request = new Request("https://managedagents.test/v1/agents", {
      headers: { authorization: "Bearer historical-token" },
    });

    expect(
      await authenticateRequest(
        request,
        {
          BLUE_ACCOUNT_ID: "unused",
          BLUE_ENVIRONMENT: "production",
          BLUE_API_KEY: "historical-token",
          OC_MANAGED_AGENTS_ONLY: "true",
        },
        new URL(request.url),
      ),
    ).toBeNull();
  });
});

describe("runtime identity", () => {
  const runtime = (method: string, path: string) =>
    authenticateRequest(
      new Request(`https://managedagents.test${path}`, { method }),
      env,
      new URL(`https://managedagents.test${path}`),
    );

  it("is given to the session connect WebSocket only", async () => {
    expect(
      await runtime("GET", "/v1/sessions/ses_1/connect?role=runtime&token=t"),
    ).toMatchObject({ kind: "runtime" });
  });

  it("is not given to other routes ending in /connect", async () => {
    expect(await runtime("POST", "/v1/github/connect?role=runtime")).toBeNull();
    expect(
      await runtime("POST", "/v1/projects/prj_1/github/connect?role=runtime"),
    ).toBeNull();
    expect(
      await runtime("POST", "/v1/sessions/ses_1/connect?role=runtime"),
    ).toBeNull();
    expect(
      await runtime("GET", "/v1/sessions/ses_1/x/connect?role=runtime"),
    ).toBeNull();
  });
});

describe("connection callback", () => {
  it("renders branded success and error states safely", () => {
    const success = renderConnectionCallback({
      provider: "Google",
      status: "success",
    });
    expect(success).toContain("Google connected");
    expect(success).toContain("within the connection's configured scope");
    expect(success).toContain("opencomputer");
    expect(success).not.toContain("Next step");
    expect(success).not.toContain('class="button');

    const failure = renderConnectionCallback({
      provider: "<Provider>",
      status: "error",
    });
    expect(failure).toContain("&lt;Provider&gt; connection failed");
    expect(failure).not.toContain("<Provider>");
  });

  it("offers one call to action and drops unsafe links", () => {
    const nextStep = {
      title: "Hand it your first task",
      description: "Mention it in Slack.",
      label: "Open your computer",
      href: "https://app.example/computer",
    };
    const success = renderConnectionCallback({
      provider: "GitHub",
      status: "success",
      dashboardUrl: "https://app.example/",
      nextStep,
    });
    expect(success).toContain('class="button primary" href="https://app.example/computer"');
    expect(success).not.toContain("Open dashboard");

    const failure = renderConnectionCallback({
      provider: "GitHub",
      status: "error",
      dashboardUrl: "javascript:alert(1)",
      nextStep,
    });
    expect(failure).not.toContain("Next step");
    expect(failure).not.toContain("javascript:");
  });
});

describe("computer grant routes", () => {
  it("refuses connecting, attaching and granting, and allows using", () => {
    for (const [method, path] of <[string, string][]>[
      ["POST", "/v1/connections"],
      ["DELETE", "/v1/connections/conn_1"],
      ["POST", "/v1/projects/p1/service-connections"],
      ["POST", "/v1/computer/service-connections"],
      ["DELETE", "/v1/computer/service-connections"],
      ["PUT", "/v1/model-access/openai"],
      ["POST", "/v1/projects/p1/linear/install"],
      ["POST", "/v1/linear/oauth/start"],
      ["POST", "/v1/channels/slack"],
      ["POST", "/v1/channel-connections/claim"],
      ["POST", "/v1/github/connect"],
      ["POST", "/v1/projects/p1/github/attach"],
    ]) {
      expect(isComputerGrantRoute(method, path), `${method} ${path}`).toBe(true);
    }
    for (const [method, path] of <[string, string][]>[
      ["GET", "/v1/connections"],
      ["post", "/v1/connections/linear/fetch"],
      ["POST", "/v1/projects"],
      ["POST", "/v1/projects/p1/deployments"],
      ["GET", "/v1/projects/p1/github"],
    ]) {
      expect(isComputerGrantRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
