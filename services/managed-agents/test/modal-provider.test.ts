import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isModalSandboxId,
  modalSandboxRetire,
  modalProviderEnabled,
  modalProviderSelected,
} from "../src/platform/modal-sandbox.js";
import { modalToolSandbox } from "../src/platform/tool-sandbox/modal.js";

const base = {
  BLUE_SANDBOX_PROVIDER: "modal",
  MODAL_SHIM_URL: "https://shim.example.com",
  MODAL_SHIM_TOKEN: "token",
};

describe("modalProviderEnabled", () => {
  it("requires the provider flag plus shim credentials", () => {
    expect(modalProviderEnabled({})).toBe(false);
    expect(modalProviderEnabled({ BLUE_SANDBOX_PROVIDER: "modal" })).toBe(false);
    expect(
      modalProviderEnabled({
        BLUE_SANDBOX_PROVIDER: "modal",
        MODAL_SHIM_URL: "https://x",
      }),
    ).toBe(false);
    expect(modalProviderEnabled(base)).toBe(true);
  });
});

describe("modalProviderSelected", () => {
  it("selects nobody when the infra is off, allowlist or not", () => {
    expect(
      modalProviderSelected({ MODAL_ACCOUNT_ALLOWLIST: "*" }, "acct-1"),
    ).toBe(false);
  });

  it("selects nobody on an empty allowlist even when infra is on", () => {
    expect(modalProviderSelected(base, "acct-1")).toBe(false);
    expect(
      modalProviderSelected({ ...base, MODAL_ACCOUNT_ALLOWLIST: "" }, "a"),
    ).toBe(false);
  });

  it("selects allowlisted accounts, tolerating whitespace", () => {
    const env = { ...base, MODAL_ACCOUNT_ALLOWLIST: " acct-1 , acct-2 " };
    expect(modalProviderSelected(env, "acct-1")).toBe(true);
    expect(modalProviderSelected(env, "acct-2")).toBe(true);
    expect(modalProviderSelected(env, "acct-3")).toBe(false);
  });

  it("selects everyone on '*'", () => {
    const env = { ...base, MODAL_ACCOUNT_ALLOWLIST: "*" };
    expect(modalProviderSelected(env, "acct-1")).toBe(true);
    expect(modalProviderSelected(env, "anything")).toBe(true);
  });

  it("buckets accounts deterministically under MODAL_ROLLOUT_PERCENT", () => {
    const at100 = { ...base, MODAL_ROLLOUT_PERCENT: "100" };
    expect(modalProviderSelected(at100, "acct-1")).toBe(true);

    const at0 = { ...base, MODAL_ROLLOUT_PERCENT: "0" };
    expect(modalProviderSelected(at0, "acct-1")).toBe(false);

    // Find one account inside and one outside a 50% gate, then confirm the
    // verdict is stable across calls — an org never flaps.
    const at50 = { ...base, MODAL_ROLLOUT_PERCENT: "50" };
    const verdicts = new Map<string, boolean>();
    let sawTrue = false;
    let sawFalse = false;
    for (let i = 0; i < 500; i += 1) {
      const id = `acct-${String(i)}`;
      const verdict = modalProviderSelected(at50, id);
      verdicts.set(id, verdict);
      sawTrue ||= verdict;
      sawFalse ||= !verdict;
    }
    expect(sawTrue).toBe(true);
    expect(sawFalse).toBe(true);
    for (const [id, verdict] of verdicts) {
      expect(modalProviderSelected(at50, id)).toBe(verdict);
    }
  });

  it("keeps an org selected once its bucket is inside the dial", () => {
    // A percent rollout must be monotonic: whatever is selected at N% stays
    // selected at N+1%.
    const ids = Array.from({ length: 200 }, (_, i) => `org-${String(i)}`);
    for (let pct = 0; pct < 100; pct += 1) {
      const lower = { ...base, MODAL_ROLLOUT_PERCENT: String(pct) };
      const higher = { ...base, MODAL_ROLLOUT_PERCENT: String(pct + 1) };
      for (const id of ids) {
        if (modalProviderSelected(lower, id)) {
          expect(modalProviderSelected(higher, id)).toBe(true);
        }
      }
    }
  });

  it("ignores malformed percent values", () => {
    for (const bad of ["abc", "-5", "NaN", ""]) {
      expect(
        modalProviderSelected(
          { ...base, MODAL_ROLLOUT_PERCENT: bad },
          "acct-1",
        ),
      ).toBe(false);
    }
  });
});

describe("isModalSandboxId", () => {
  it("routes by the sb- prefix", () => {
    expect(isModalSandboxId("sb-01M4KJK0")).toBe(true);
    expect(isModalSandboxId("microvm-123")).toBe(false);
    expect(isModalSandboxId("")).toBe(false);
  });
});

describe("modalSandboxRetire", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function shim(responses: Record<string, number>) {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        const status = responses[path] ?? 404;
        return Response.json(
          path.endsWith("/suspend")
            ? { image_id: "im-snap", snapshot_ms: 1200, terminated: true }
            : {},
          { status },
        );
      }),
    );
    return calls;
  }

  it("snapshots instead of terminating when the retirement preserves", async () => {
    const calls = shim({ "/sandboxes/sb-1/suspend": 200 });
    await expect(
      modalSandboxRetire(base, "sb-1", { sessionId: "ses-1", preserve: true }),
    ).resolves.toEqual({ preserved: true, imageId: "im-snap", snapshotMs: 1200 });
    expect(calls).toEqual([
      { path: "/sandboxes/sb-1/suspend", body: { session_id: "ses-1" } },
    ]);
  });

  it("terminates without a snapshot when the retirement does not preserve", async () => {
    const calls = shim({ "/sandboxes/sb-1/terminate": 200 });
    await expect(
      modalSandboxRetire(base, "sb-1", { sessionId: "ses-1", preserve: false }),
    ).resolves.toEqual({ preserved: false });
    expect(calls.map((call) => call.path)).toEqual(["/sandboxes/sb-1/terminate"]);
  });

  it("falls back to terminate when the snapshot fails", async () => {
    const calls = shim({
      "/sandboxes/sb-1/suspend": 500,
      "/sandboxes/sb-1/terminate": 200,
    });
    await expect(
      modalSandboxRetire(base, "sb-1", { sessionId: "ses-1", preserve: true }),
    ).resolves.toMatchObject({ preserved: false, snapshotError: expect.stringContaining("500") });
    expect(calls.map((call) => call.path)).toEqual([
      "/sandboxes/sb-1/suspend",
      "/sandboxes/sb-1/terminate",
    ]);
  });

  it("fails the retirement when the fallback terminate fails too", async () => {
    shim({ "/sandboxes/sb-1/suspend": 500, "/sandboxes/sb-1/terminate": 503 });
    await expect(
      modalSandboxRetire(base, "sb-1", { sessionId: "ses-1", preserve: true }),
    ).rejects.toThrow(/terminate returned 503/);
  });
});

describe("modal runtimeStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function shim(status: number, body: unknown = {}) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
  }
  const provider = () =>
    modalToolSandbox(base as unknown as Parameters<typeof modalToolSandbox>[0]);

  it("reads a running sandbox as running", async () => {
    shim(200, { sandbox_id: "sb-1", status: "running" });
    await expect(provider().runtimeStatus!("sb-1")).resolves.toBe("running");
  });

  it("reads an exited sandbox as terminated", async () => {
    shim(200, { sandbox_id: "sb-1", status: "terminated" });
    await expect(provider().runtimeStatus!("sb-1")).resolves.toBe("terminated");
  });

  it("reads a sandbox Modal no longer knows as terminated", async () => {
    shim(404);
    await expect(provider().runtimeStatus!("sb-1")).resolves.toBe("terminated");
  });

  it("fails rather than guessing when the shim errors", async () => {
    shim(503);
    await expect(provider().runtimeStatus!("sb-1")).rejects.toThrow(/503/);
  });
});
