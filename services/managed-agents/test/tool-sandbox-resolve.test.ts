import { afterEach, describe, expect, it, vi } from "vitest";

import {
  toolSandboxForEnsure,
  toolSandboxForId,
  toolSandboxForWorkspace,
} from "../src/platform/tool-sandbox/resolve.js";
import type { AgentDeployment } from "../src/protocol.js";
import type { SandboxEnsureInput } from "../src/platform/sandbox-adapter.js";
import type { PlatformEnv } from "../src/platform/tool-sandbox/shared.js";

const modalOn = {
  BLUE_SANDBOX_PROVIDER: "modal",
  MODAL_SHIM_URL: "https://shim.example.com",
  MODAL_SHIM_TOKEN: "token",
} as unknown as PlatformEnv;
const modalOff = {} as PlatformEnv;
const everyone = { ...modalOn, MODAL_ACCOUNT_ALLOWLIST: "*" } as PlatformEnv;
const ensureInput = { accountId: "acct-1", workspace: { id: "ses-1" } };
const scope = { accountId: "acct-1", sessionId: "ses-1" };

describe("toolSandboxForId", () => {
  it("routes sb- ids to Modal only while the provider is configured", () => {
    expect(toolSandboxForId(modalOn, "sb-01M4KJK0").name).toBe("modal");
    expect(toolSandboxForId(modalOff, "sb-01M4KJK0").name).toBe("none");
  });

  it("never hands an id that is not Modal's to Modal", () => {
    expect(toolSandboxForId(modalOn, "microvm-123").name).toBe("none");
    expect(toolSandboxForId(everyone, "microvm-123").name).toBe("none");
  });

  it("gives only Modal the session-runtime status hook", () => {
    expect(toolSandboxForId(modalOn, "sb-1").runtimeStatus).toBeTypeOf("function");
    expect(toolSandboxForId(modalOn, "microvm-1").runtimeStatus).toBeUndefined();
  });
});

describe("a sandbox id no provider owns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retires and terminates as already gone, without a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const provider = toolSandboxForId(everyone, "microvm-123");
    await expect(
      provider.retire({
        sandboxId: "microvm-123",
        sessionID: "ses-1",
        generation: 1,
        preserve: false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      provider.runtimeAction?.("microvm-123", "terminate"),
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cannot be suspended or resumed", async () => {
    const provider = toolSandboxForId(everyone, "microvm-123");
    await expect(provider.runtimeAction?.("microvm-123", "suspend")).rejects.toThrow(
      "No sandbox provider can suspend microvm-123",
    );
    await expect(provider.runtimeAction?.("microvm-123", "resume")).rejects.toThrow(
      "No sandbox provider can resume microvm-123",
    );
  });

  it("has no endpoint", async () => {
    await expect(
      toolSandboxForId(everyone, "microvm-123").endpoint("microvm-123"),
    ).resolves.toEqual({ unavailable: "unknown" });
  });

  it("does not report a Modal sandbox gone while Modal is not configured", async () => {
    const provider = toolSandboxForId(modalOff, "sb-1");
    await expect(
      provider.retire({
        sandboxId: "sb-1",
        sessionID: "ses-1",
        generation: 1,
        preserve: false,
      }),
    ).rejects.toThrow("The Modal sandbox provider is not configured");
    await expect(provider.runtimeAction?.("sb-1", "terminate")).rejects.toThrow(
      "The Modal sandbox provider is not configured",
    );
  });
});

describe("toolSandboxForEnsure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives an org outside the gate no provider", async () => {
    expect((await toolSandboxForEnsure(modalOn, ensureInput)).name).toBe("none");
  });

  it("gives everyone no provider when Modal is not configured", async () => {
    const env = { MODAL_ACCOUNT_ALLOWLIST: "*" } as PlatformEnv;
    expect((await toolSandboxForEnsure(env, ensureInput)).name).toBe("none");
  });

  it("sends a workspace of a selected org to Modal without a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await toolSandboxForEnsure(everyone, ensureInput)).name).toBe("modal");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives a deployment whose operator runtime profile has no Modal image no provider", async () => {
    const deployment = {
      managedRuntimeProfileId: "acme-scanner",
    } as unknown as AgentDeployment;
    expect(
      (await toolSandboxForEnsure(everyone, { ...ensureInput, deployment })).name,
    ).toBe("none");
  });

  it("sends a profile with a Modal image through the gate like everyone else", async () => {
    const deployment = {
      managedRuntimeProfileId: "acme-scanner",
      managedRuntimeModalImage: "oc-acme-runtime-amd64",
      managedRuntimeSupervisorPort: 9090,
    } as unknown as AgentDeployment;
    expect(
      (await toolSandboxForEnsure(everyone, { ...ensureInput, deployment })).name,
    ).toBe("modal");
    expect(
      (await toolSandboxForEnsure(modalOn, { ...ensureInput, deployment })).name,
    ).toBe("none");
  });

  it("refuses the ensure of an account without a provider, starting nothing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const provider = await toolSandboxForEnsure(modalOn, ensureInput);
    const response = await provider.ensure(
      {} as SandboxEnsureInput,
      Date.now(),
      async () => new Response(null),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "sandbox_provider_unavailable",
      message: "No sandbox provider is configured",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("toolSandboxForWorkspace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads an empty workspace without asking the shim when Modal is off", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const provider = await toolSandboxForWorkspace(modalOff, "ses-1");
    expect(provider.name).toBe("none");
    const listed = await provider.listFiles(scope, undefined);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ files: [], nextCursor: null });
    const exported = await provider.exportFile(scope, "report.txt", null);
    expect(exported.status).toBe(404);
    expect(await exported.json()).toEqual({
      code: "artifact_not_found",
      message: "Workspace file not found",
    });
    const signed = await provider.signDownload(scope, "report.txt");
    expect(signed.status).toBe(404);
    expect(await signed.json()).toEqual({
      code: "artifact_not_found",
      message: "Workspace file not found",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows the volume, not the gate", async () => {
    const fetch = vi.fn(async () => Response.json({ entries: [], next_cursor: null }));
    vi.stubGlobal("fetch", fetch);
    // modalOn selects nobody, yet the session's volume exists.
    expect((await toolSandboxForWorkspace(modalOn, "ses-1")).name).toBe("modal");
    expect(fetch).toHaveBeenCalledWith(
      "https://shim.example.com/volumes/oc-ws-ses-1/list",
      expect.anything(),
    );
  });

  it("reads an empty workspace when there is no volume or the shim fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect((await toolSandboxForWorkspace(everyone, "ses-1")).name).toBe("none");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect((await toolSandboxForWorkspace(everyone, "ses-1")).name).toBe("none");
  });
});
