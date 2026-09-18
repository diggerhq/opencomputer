// The root's transport contract: importing the package installs nothing and
// opens nothing; a sandbox request goes to the global fetch with the client's
// own undici Agent as its per-request dispatcher; the process's global
// dispatcher is the one Node started with, before and after.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher } from "undici";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sandbox client transport", () => {
  it("leaves the global dispatcher alone and passes its own pool per request", async () => {
    const before = getGlobalDispatcher();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { Sandbox } = await import("./index.js");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getGlobalDispatcher()).toBe(before);

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sandboxID: "sb_1", status: "running" }), { status: 200 }),
    );
    const sandbox = await Sandbox.connect("sb_1", { apiKey: "k", apiUrl: "https://api.example.test" });
    expect(sandbox.sandboxId).toBe("sb_1");

    const [, init] = fetchMock.mock.calls[0] as [unknown, { dispatcher?: unknown }];
    expect(init.dispatcher).toBeInstanceOf(Agent);
    expect(init.dispatcher).not.toBe(before);
    expect(getGlobalDispatcher()).toBe(before);
  });

  it("reuses one pool across requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ sandboxID: "sb_2", status: "running" }), { status: 200 }));
    const { Sandbox } = await import("./index.js");
    await Sandbox.connect("sb_2", { apiKey: "k", apiUrl: "https://api.example.test" });
    await Sandbox.connect("sb_2", { apiKey: "k", apiUrl: "https://api.example.test" });
    const pools = fetchMock.mock.calls.map(([, init]) => (init as { dispatcher?: unknown }).dispatcher);
    expect(pools[0]).toBeInstanceOf(Agent);
    expect(pools[1]).toBe(pools[0]);
  });
});
