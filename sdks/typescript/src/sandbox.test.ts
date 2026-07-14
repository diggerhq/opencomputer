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

describe("Sandbox public network policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends public policy on a fresh create", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sandboxID: "sb_1", status: "running" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    await Sandbox.create({
      apiUrl: "https://api.example.test",
      apiKey: "osb_test",
      networkPolicy: "public",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({ networkPolicy: "public" });
  });

  it("sends public policy through named-snapshot create", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        'event: result\ndata: {"sandboxID":"sb_2","status":"running"}\n\n',
        { status: 201, headers: { "content-type": "text/event-stream" } },
      ),
    );

    await Sandbox.create({
      apiUrl: "https://api.example.test",
      snapshot: "flue-builder",
      networkPolicy: "public",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      snapshot: "flue-builder",
      networkPolicy: "public",
    });
  });

  it("sends public policy on direct checkpoint create", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sandboxID: "sb_3", status: "running" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    await Sandbox.createFromCheckpoint("cp_1", {
      apiUrl: "https://api.example.test",
      networkPolicy: "public",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ networkPolicy: "public" });
  });
});
