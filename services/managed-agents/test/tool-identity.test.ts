import { describe, expect, it } from "vitest";

import {
  freezeToolInvocationIdentity,
  parseSessionIdentity,
  parseToolInvocationIdentity,
} from "../src/tool-identity.js";

const full = {
  projectId: "prj_1",
  environment: "development",
  agentId: "agent_1",
  deploymentId: "dep_1",
  sessionId: "ses_1",
  turnId: "turn_1",
  messageId: "msg_1",
  toolCallId: "call_1",
  providerCallId: "provider_call_1",
};

describe("the host identity parsers", () => {
  it("accept a single-mode project's default scope", () => {
    expect(parseSessionIdentity({ ...full, environment: "default" })?.environment).toBe("default");
    expect(parseSessionIdentity({ ...full, environment: "staging" })).toBeUndefined();
  });

  it("accept a complete tuple and return only its fields", () => {
    expect(parseToolInvocationIdentity({ ...full, extra: "ignored" })).toEqual(full);
    expect(parseSessionIdentity({ ...full, turnId: 5 })).toEqual({
      projectId: "prj_1",
      environment: "development",
      agentId: "agent_1",
      deploymentId: "dep_1",
      sessionId: "ses_1",
    });
  });

  it("refuse a missing or empty field, an unknown environment, and a non-object", () => {
    for (const field of Object.keys(full)) {
      expect(parseToolInvocationIdentity({ ...full, [field]: "" })).toBeUndefined();
      const rest: Record<string, string> = { ...full };
      delete rest[field];
      expect(parseToolInvocationIdentity(rest)).toBeUndefined();
    }
    expect(parseToolInvocationIdentity({ ...full, environment: "staging" })).toBeUndefined();
    expect(parseToolInvocationIdentity({ ...full, turnId: 1 })).toBeUndefined();
    expect(parseToolInvocationIdentity(null)).toBeUndefined();
    expect(parseToolInvocationIdentity([full])).toBeUndefined();
    expect(parseToolInvocationIdentity("prj_1")).toBeUndefined();
  });
});

describe("the frozen identity", () => {
  it("is a new, frozen copy of the identity fields that ignores writes", () => {
    const source = { ...full, environment: "production" as const, extra: "dropped" };
    const frozen = freezeToolInvocationIdentity(source);
    expect(frozen).toEqual({ ...full, environment: "production" });
    expect(frozen).not.toBe(source);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen as { turnId: string }).turnId = "turn_forged";
    }).toThrow(TypeError);
    expect(() => {
      Object.assign(frozen, { deploymentId: "dep_forged" });
    }).toThrow(TypeError);
    expect(frozen.turnId).toBe("turn_1");
    expect(frozen.deploymentId).toBe("dep_1");
    // Mutating the source afterwards does not reach the copy.
    source.sessionId = "ses_other";
    expect(frozen.sessionId).toBe("ses_1");
  });
});
