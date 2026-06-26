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

    const sandbox = Object.create(Sandbox.prototype) as Sandbox & {
      apiUrl: string;
      apiKey: string;
      sandboxId: string;
    };
    sandbox.apiUrl = "https://api.example.test/api";
    sandbox.apiKey = "osb_test";
    sandbox.sandboxId = "sb_1";

    await sandbox.createCheckpoint("autosave", {
      retentionPolicy: { mode: "delete_oldest", maxCount: 3 },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "autosave",
      retentionPolicy: { mode: "delete_oldest", maxCount: 3 },
    });
  });
});
