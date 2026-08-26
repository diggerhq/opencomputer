import { afterEach, describe, expect, it, vi } from "vitest";
import { Sandbox } from "./sandbox.js";

describe("Sandbox checkpoint requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends delete_oldest retention policy when creating a checkpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        id: "cp_1",
        sandboxId: "sb_1",
        orgId: "org_1",
        name: "autosave",
        sandboxConfig: {},
        status: "processing",
        sizeBytes: 0,
        createdAt: "2026-01-01T00:00:00Z",
      }), { status: 201, headers: { "content-type": "application/json" } }),
    );

    const sandbox = Object.create(Sandbox.prototype) as Sandbox;
    const sandboxState = sandbox as unknown as Record<string, unknown>;
    sandboxState.apiUrl = "https://api.example.test/api";
    sandboxState.apiKey = "osb_test";
    sandboxState.sandboxId = "sb_1";

    await sandbox.createCheckpoint("autosave", {
      retentionPolicy: { mode: "delete_oldest", maxCount: 3 },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "autosave",
      retentionPolicy: { mode: "delete_oldest", maxCount: 3 },
    });
  });

  it("preserves explicit false for disk-only promotion override", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        id: "cp_1",
        sandboxId: "sb_1",
        orgId: "org_1",
        name: "manual",
        sandboxConfig: {},
        kind: "disk_only",
        status: "processing",
        sizeBytes: 0,
        createdAt: "2026-01-01T00:00:00Z",
      }), { status: 201, headers: { "content-type": "application/json" } }),
    );

    const sandbox = Object.create(Sandbox.prototype) as Sandbox;
    const sandboxState = sandbox as unknown as Record<string, unknown>;
    sandboxState.apiUrl = "https://api.example.test/api";
    sandboxState.apiKey = "osb_test";
    sandboxState.sandboxId = "sb_1";

    await sandbox.createCheckpoint("manual", {
      kind: "disk_only",
      promoteToFull: false,
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "manual",
      kind: "disk_only",
      promoteToFull: false,
    });
  });
});

describe("Sandbox.destroy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The bug this exists to prevent: connect()+kill() reads a 404 from the GET
  // as "already gone" and never issues the DELETE, leaking a live sandbox while
  // reporting success. destroy() must go straight to the DELETE.
  it("issues DELETE without a preceding GET", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await Sandbox.destroy("sb_1", { apiUrl: "https://api.example.test/api", apiKey: "osb_test" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.example.test/api/sandboxes/sb_1");
    expect(init?.method).toBe("DELETE");
  });

  // A 404 from the DELETE means the sandbox really is gone, which is the
  // caller's desired end state.
  it("treats a 404 from the DELETE as success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      Sandbox.destroy("sb_missing", { apiUrl: "https://api.example.test/api", apiKey: "osb_test" }),
    ).resolves.toBeUndefined();
  });

  // Anything else must throw: a delete that did not happen must never look
  // like one that did.
  it("throws when the delete genuinely failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    await expect(
      Sandbox.destroy("sb_1", { apiUrl: "https://api.example.test/api", apiKey: "osb_test" }),
    ).rejects.toThrow(/Failed to destroy sandbox sb_1: 500/);
  });

  it("forwards deleteSecretStore", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await Sandbox.destroy("sb_1", {
      apiUrl: "https://api.example.test/api",
      apiKey: "osb_test",
      deleteSecretStore: true,
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.example.test/api/sandboxes/sb_1?deleteSecretStore=true",
    );
  });
});
