import { describe, expect, it } from "vitest";

import type { AgentDeployment } from "../src/protocol.js";
import {
  configuredManagedRuntimeProfileAssignment,
  managedRuntimeProfile,
  managedRuntimeProfiles,
  runtimeDeploymentForProfile,
} from "../src/edge/runtime-profiles.js";

const deployment = {
  id: "dep-1",
  agentId: "agent-1",
  alias: "production",
  runtimeMode: "workerd-lazy-sandbox",
  artifact: {
    bucket: "artifacts",
    key: "agent.tgz",
    digest: "a".repeat(64),
    size: 1,
  },
  imageArn: "deployment-image",
  imageVersion: "1",
  channels: [],
  connections: [],
  httpConnections: [],
  createdAt: new Date(0).toISOString(),
} satisfies AgentDeployment;

const env = {
  BLUE_RUNTIME_IMAGE_ARN: "default-image",
  BLUE_RUNTIME_IMAGE_VERSION: "46.0",
  MANAGED_RUNTIME_PROFILES: JSON.stringify({
    "acme-scanner": {
      displayName: "Acme scanning",
      imageArn: "dedicated-acme-image",
      imageVersion: "1.0",
    },
  }),
};

describe("managed runtime profiles", () => {
  it("resolves only an operator-configured opaque profile", () => {
    expect(managedRuntimeProfile(env, "acme-scanner")).toEqual({
      id: "acme-scanner",
      displayName: "Acme scanning",
      imageArn: "dedicated-acme-image",
      imageVersion: "1.0",
    });
    expect(() => managedRuntimeProfile(env, "unknown")).toThrow(
      "is not configured",
    );
  });

  it("carries a profile's Modal image and supervisor port to the runtime deployment", () => {
    const withModal = {
      ...env,
      MANAGED_RUNTIME_PROFILES: JSON.stringify({
        "acme-scanner": {
          displayName: "Acme scanning",
          imageArn: "dedicated-acme-image",
          imageVersion: "1.0",
          modalImage: "oc-acme-runtime-amd64",
          supervisorPort: 9090,
        },
      }),
    };
    const profile = managedRuntimeProfile(withModal, "acme-scanner");
    expect(runtimeDeploymentForProfile(withModal, deployment, profile)).toMatchObject({
      managedRuntimeProfileId: "acme-scanner",
      managedRuntimeModalImage: "oc-acme-runtime-amd64",
      managedRuntimeSupervisorPort: 9090,
    });
    expect(
      runtimeDeploymentForProfile(env, deployment, managedRuntimeProfile(env, "acme-scanner")),
    ).not.toHaveProperty("managedRuntimeModalImage");
  });

  it("rejects a malformed Modal image or supervisor port", () => {
    for (const extra of [{ modalImage: "bad name" }, { supervisorPort: 70_000 }, { supervisorPort: "9090" }]) {
      expect(() =>
        managedRuntimeProfiles({
          MANAGED_RUNTIME_PROFILES: JSON.stringify({
            "acme-scanner": {
              displayName: "Acme scanning",
              imageArn: "dedicated-acme-image",
              imageVersion: "1.0",
              ...extra,
            },
          }),
        }),
      ).toThrow("is invalid");
    }
  });

  it("makes the customer image win over both deployment and default images", () => {
    const profile = managedRuntimeProfile(env, "acme-scanner");
    expect(runtimeDeploymentForProfile(env, deployment, profile)).toMatchObject({
      imageArn: "dedicated-acme-image",
      imageVersion: "1.0",
    });
    expect(runtimeDeploymentForProfile(env, deployment, null)).toMatchObject({
      imageArn: "default-image",
      imageVersion: "46.0",
    });
  });

  it("fails closed on malformed operator configuration", () => {
    expect(() =>
      managedRuntimeProfiles({ MANAGED_RUNTIME_PROFILES: "not-json" }),
    ).toThrow("invalid JSON");
    expect(() =>
      managedRuntimeProfiles({
        MANAGED_RUNTIME_PROFILES: JSON.stringify({
          "bad profile": { displayName: "Bad", imageArn: "x", imageVersion: "1" },
        }),
      }),
    ).toThrow("is invalid");
  });

  it("selects only the account named by an operator assignment", () => {
    const assignments = {
      MANAGED_RUNTIME_PROFILE_ASSIGNMENTS: JSON.stringify({
        "org-selected": "acme-scanner",
      }),
    };
    expect(
      configuredManagedRuntimeProfileAssignment(assignments, "org-selected"),
    ).toBe("acme-scanner");
    expect(
      configuredManagedRuntimeProfileAssignment(assignments, "org-default"),
    ).toBeNull();
  });
});
