import { describe, expect, it } from "vitest";

import type { AgentDeployment } from "../src/protocol.js";
import {
  modalSessionRuntimeCreateRequest,
  modalSessionRuntimeSelected,
  sessionRuntimeProvider,
} from "../src/platform/modal-session-runtime.js";

const modalEnv = {
  BLUE_SANDBOX_PROVIDER: "modal",
  MODAL_SHIM_URL: "https://shim.example.com",
  MODAL_SHIM_TOKEN: "token",
};

const deployment: AgentDeployment = {
  id: "dep-1",
  agentId: "agent-1",
  alias: "main",
  runtimeMode: "microvm",
  channels: [],
  connections: [],
  httpConnections: [],
  artifact: { bucket: "artifacts", key: "dep-1.tar", digest: "sha256:abc", size: 10 },
  imageArn: "arn:aws:lambda:us-east-1:1:image/x",
  imageVersion: "3",
  createdAt: "2026-10-24T00:00:00Z",
};

const input = {
  accountId: "acct-1",
  projectId: "proj-1",
  sessionId: "sess-1",
  runtimeToken: "rt-token",
  edge: "edge.example.com",
  deployment,
};

describe("sessionRuntimeProvider", () => {
  it("is aws by default", () => {
    expect(sessionRuntimeProvider({})).toBe("aws");
    expect(sessionRuntimeProvider({ BLUE_SESSION_RUNTIME_PROVIDER: "aws" })).toBe("aws");
    expect(modalSessionRuntimeSelected(modalEnv)).toBe(false);
  });

  it("is modal only when the shim is configured, and fails closed otherwise", () => {
    expect(
      modalSessionRuntimeSelected({ ...modalEnv, BLUE_SESSION_RUNTIME_PROVIDER: "modal" }),
    ).toBe(true);
    expect(() =>
      sessionRuntimeProvider({ BLUE_SESSION_RUNTIME_PROVIDER: "modal" }),
    ).toThrow(/BLUE_SANDBOX_PROVIDER=modal/);
    expect(() =>
      sessionRuntimeProvider({
        BLUE_SESSION_RUNTIME_PROVIDER: "modal",
        BLUE_SANDBOX_PROVIDER: "modal",
        MODAL_SHIM_URL: "https://x",
      }),
    ).toThrow();
    expect(() =>
      sessionRuntimeProvider({ BLUE_SESSION_RUNTIME_PROVIDER: "fly" }),
    ).toThrow(/Unknown/);
  });
});

describe("modalSessionRuntimeCreateRequest", () => {
  const env = {
    ...modalEnv,
    MODAL_SANDBOX_IMAGE: "oc-blue-runtime",
    MODAL_SANDBOX_APP: "opencomputer-sandboxes",
    MODAL_VOLUME_PREFIX: "oc-ws-",
    MODAL_SANDBOX_CPU: "4",
    MODAL_SANDBOX_MEMORY_MIB: "8192",
    AWS_ACCESS_KEY_ID: "AKIA",
    AWS_SECRET_ACCESS_KEY: "secret",
    BLUE_AWS_REGION: "us-east-1",
  };

  it("sends the managed-agent run hook with the workspace volume mounted", () => {
    const request = modalSessionRuntimeCreateRequest(env, input, {
      snapshotImageId: null,
      sandboxToken: "sb-token",
    });
    expect(request.image_name).toBe("oc-blue-runtime");
    expect(request.app_name).toBe("opencomputer-sandboxes");
    expect(request.session_id).toBe("sess-1");
    expect(request.volume_name).toBe("oc-ws-sess-1");
    expect(request.mount_path).toBe("/workspace");
    expect(request.cpu).toBe(4);
    expect(request.memory_mib).toBe(8192);
    expect(request.timeout_seconds).toBe(86_400);
    expect(request.snapshot_image_id).toBeUndefined();
    expect(request.outbound_domain_allowlist).toBeUndefined();
    expect(request.env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_REGION: "us-east-1",
      BLUE_SANDBOX_TOKEN: "sb-token",
    });
    expect(request.run_hook_payload).toEqual({
      edge: "edge.example.com",
      projectId: "proj-1",
      deploymentId: "dep-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      runtimeToken: "rt-token",
      agentArtifact: deployment.artifact,
      fileSystem: { id: "oc-ws-sess-1", backend: "mounted", mountPath: "/workspace" },
    });
    // Not a tool-sandbox hook: the supervisor must take the managed-agent branch.
    expect(request.run_hook_payload).not.toHaveProperty("toolSandbox");
    // The edge's waitUntil budget is shorter than boot plus OpenCode start.
    expect(request.run_hook_async).toBe(true);
  });

  it("resumes from the session's snapshot and defaults sizing", () => {
    const request = modalSessionRuntimeCreateRequest(
      { ...modalEnv, MODAL_SANDBOX_IMAGE: "oc-blue-runtime" },
      input,
      { snapshotImageId: "im-123", sandboxToken: "t" },
    );
    expect(request.snapshot_image_id).toBe("im-123");
    expect(request.cpu).toBe(2);
    expect(request.memory_mib).toBe(4096);
    expect(request.app_name).toBeUndefined();
  });
});
