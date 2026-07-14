import { afterEach, describe, expect, it, vi } from "vitest";
import { ocSandbox } from "./sandbox.js";

afterEach(() => vi.unstubAllGlobals());

async function initialize(id = "ses_1") {
  const factory = ocSandbox({
    OC_SANDBOX_API: "https://api.opencomputer.test",
    OC_SESSION_TOKEN: "deploy-token",
  });
  const env = await factory.createSessionEnv({ id });
  // Flue beta.9's fixed harness bootstrap sequence.
  expect(await env.exists("/workspace/AGENTS.md")).toBe(false);
  expect(await env.exists("/workspace/CLAUDE.md")).toBe(false);
  expect(await env.exists("/workspace/.agents/skills")).toBe(false);
  expect(await env.readdir("/workspace")).toEqual([]);
  return { factory, env };
}

describe("ocSandbox lazy allocation", () => {
  it("makes zero requests for initialization and model/custom-tool-only work", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await initialize();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shares one resolution across concurrent first operations and reuses it", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/flue/session-sandbox")) {
          return new Response(JSON.stringify({ sandbox_id: "sbx_1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/exec/run")) {
          return new Response(
            JSON.stringify({ exitCode: 0, stdout: "ok", stderr: "" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("hello", { status: 200 });
      }),
    );
    const { factory, env } = await initialize();
    await Promise.all([env.exec("echo one"), env.readFile("note.txt")]);
    const laterTurn = await factory.createSessionEnv({ id: "ses_1" });
    expect(await laterTurn.exists("/workspace/AGENTS.md")).toBe(false);
    expect(await laterTurn.exists("/workspace/CLAUDE.md")).toBe(false);
    expect(await laterTurn.exists("/workspace/.agents/skills")).toBe(false);
    expect(await laterTurn.readdir("/workspace")).toEqual([]);
    await laterTurn.exec("echo later turn");

    expect(
      calls.filter((url) => url.includes("/flue/session-sandbox")),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url.includes("/sandboxes/sbx_1/")),
    ).toHaveLength(3);
  });

  it("surfaces resolution failure to the invoking operation and permits a later retry", async () => {
    let resolves = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/flue/session-sandbox")) {
          resolves++;
          if (resolves === 1)
            return new Response("unavailable", { status: 503 });
          return new Response(JSON.stringify({ sandbox_id: "sbx_retry" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ exitCode: 0, stdout: "ok", stderr: "" }),
          { status: 200 },
        );
      }),
    );
    const { env } = await initialize();
    await expect(env.exec("first")).rejects.toThrow(
      "oc sandbox resolve failed",
    );
    await expect(env.exec("second")).resolves.toMatchObject({ exitCode: 0 });
    expect(resolves).toBe(2);
  });
});
