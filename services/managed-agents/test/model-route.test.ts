import { describe, expect, it } from "vitest";

import type { ModelRoute } from "../src/protocol.js";
import {
  connectionSupportsProtocol,
  managedResponsesModel,
  resolveModelRoute,
} from "../src/edge/model-route.js";

const projectRoute: ModelRoute = {
  id: "mr_project",
  organizationId: "org_test",
  projectId: "prj_test",
  environment: "development",
  connectionId: "mac_scx",
  model: "GLM-5.3",
  fallback: "fail",
  revision: 3,
  updatedByUserId: "usr_admin",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

describe("model route resolution", () => {
  it("uses an agent route ahead of the project route and useModel", () => {
    const result = resolveModelRoute({
      routes: [
        projectRoute,
        { ...projectRoute, id: "mr_agent", agentId: "agent_a", model: "deepseek-v4-flash" },
      ],
      agentId: "agent_a",
      requested: { provider: "openai", model: "gpt-5.6-sol" },
    });
    expect(result).toMatchObject({
      source: "agent_route",
      requested: { provider: "openai", model: "gpt-5.6-sol" },
      effective: { provider: "connection", model: "deepseek-v4-flash" },
      route: { id: "mr_agent", revision: 3 },
    });
  });

  it("uses the project route when useModel is specified", () => {
    const result = resolveModelRoute({
      routes: [projectRoute],
      agentId: "agent_b",
      requested: { provider: "openai", model: "gpt-5.6-sol" },
    });
    expect(result?.source).toBe("project_route");
    expect(result?.effective.model).toBe("GLM-5.3");
    expect(result?.requested?.model).toBe("gpt-5.6-sol");
  });

  it("uses the project route when useModel is absent", () => {
    const result = resolveModelRoute({ routes: [projectRoute], agentId: "agent_b" });
    expect(result).toMatchObject({
      source: "project_route",
      effective: { provider: "connection", model: "GLM-5.3" },
    });
    expect(result?.requested).toBeUndefined();
  });

  it("uses useModel when no route applies", () => {
    const requested = { provider: "openrouter", model: "openai/gpt-5" };
    expect(resolveModelRoute({ routes: [], agentId: "agent_a", requested })).toEqual({
      source: "use_model",
      requested,
      effective: requested,
    });
  });

  it("uses the platform default only when neither route nor useModel applies", () => {
    const platformDefault = { provider: "openrouter", model: "openai/gpt-5-mini" };
    expect(
      resolveModelRoute({ routes: [], agentId: "agent_a", platformDefault }),
    ).toEqual({ source: "platform_default", effective: platformDefault });
  });

  it("returns null when no model source exists", () => {
    expect(resolveModelRoute({ routes: [], agentId: "agent_a" })).toBeNull();
  });
});

describe("route protocol compatibility", () => {
  it("allows OpenRouter for every gateway protocol", () => {
    expect(connectionSupportsProtocol("openrouter_api_key", "chat_completions")).toBe(true);
    expect(connectionSupportsProtocol("openrouter_api_key", "responses")).toBe(true);
    expect(connectionSupportsProtocol("openrouter_api_key", "anthropic_messages")).toBe(true);
  });

  it("fails closed for incompatible custom, Codex, and Claude routes", () => {
    expect(connectionSupportsProtocol("openai_compatible_api", "chat_completions")).toBe(true);
    expect(connectionSupportsProtocol("openai_compatible_api", "responses")).toBe(false);
    expect(connectionSupportsProtocol("codex_subscription", "chat_completions")).toBe(false);
    expect(connectionSupportsProtocol("claude_subscription", "responses")).toBe(false);
  });
});

describe("managed Responses model", () => {
  it("keeps a Codex route's pinned model when it falls back at its usage limit", () => {
    const requested = { provider: "openai", model: "gpt-5-mini" };
    expect(managedResponsesModel(requested, { provider: "connection", model: "gpt-5" })).toBe(
      "openai/gpt-5",
    );
    expect(managedResponsesModel(requested)).toBe("openai/gpt-5-mini");
    expect(managedResponsesModel(undefined)).toBeUndefined();
  });
});
