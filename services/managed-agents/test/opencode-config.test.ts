import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  effectiveRuntimeModel,
  workspaceModel,
} from "../src/microvm/opencode-config.js";

describe("agent OpenCode configuration", () => {
  it("prefers the artifact-selected model over the managed default", () => {
    expect(
      effectiveRuntimeModel(
        "openai/gpt-5",
        "openrouter/anthropic/claude-sonnet-4.6",
      ),
    ).toBe("openai/gpt-5");
    expect(
      effectiveRuntimeModel(
        undefined,
        "openrouter/anthropic/claude-sonnet-4.6",
      ),
    ).toBe("openrouter/anthropic/claude-sonnet-4.6");
  });

  it("loads the compiler-selected model into the supervisor configuration", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "oc-model-config-"));
    try {
      await writeFile(
        resolve(workspace, "opencode.json"),
        JSON.stringify({ model: "openrouter/openai/gpt-5" }),
      );
      await expect(workspaceModel(workspace)).resolves.toBe(
        "openrouter/openai/gpt-5",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("allows older artifacts without an OpenCode configuration", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "oc-model-config-"));
    try {
      await expect(workspaceModel(workspace)).resolves.toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects malformed model selections", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "oc-model-config-"));
    try {
      await writeFile(
        resolve(workspace, "opencode.json"),
        JSON.stringify({ model: "gpt-5" }),
      );
      await expect(workspaceModel(workspace)).rejects.toThrow(
        "provider/model",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
