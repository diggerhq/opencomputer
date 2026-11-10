import { describe, expect, it } from "vitest";
import {
  SWEEP_ORPHAN_GRACE_MS,
  sweepIdleSandboxes,
  type SandboxSweepEnv,
} from "../src/edge/sandbox-sweep.js";

type Verdict = { verdict: "armed" | "waiting" | "keep" | "orphan"; accountId?: string };

function sweepEnv(
  sandboxes: Array<{ sandboxId: string; sessionId: string | null; seenAtMs: number }>,
  verdicts: Record<string, Verdict | Error>,
) {
  const terminated: Array<{ sessionId: string; body: unknown }> = [];
  const runtimes = {
    async fetch(input: string, init?: RequestInit) {
      const url = new URL(input);
      if (url.pathname === "/v1/sandboxes/live") return Response.json({ sandboxes });
      const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/terminate$/);
      if (match?.[1]) {
        terminated.push({
          sessionId: decodeURIComponent(match[1]),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({});
      }
      return new Response(null, { status: 404 });
    },
  };
  const sessions = {
    getByName(sessionId: string) {
      return {
        async sweepRuntime(_sandboxId: string) {
          const verdict = verdicts[sessionId];
          if (verdict instanceof Error) throw verdict;
          return verdict;
        },
      };
    },
  };
  return {
    env: { RUNTIMES: runtimes, SESSIONS: sessions } as unknown as SandboxSweepEnv,
    terminated,
  };
}

describe("the idle sandbox sweep", () => {
  const now = Date.UTC(2026, 9, 28, 12);
  const old = now - SWEEP_ORPHAN_GRACE_MS - 1;

  it("terminates an old orphan and leaves the rest to their sessions", async () => {
    const { env, terminated } = sweepEnv(
      [
        { sandboxId: "sb-idle", sessionId: "s-idle", seenAtMs: old },
        { sandboxId: "sb-busy", sessionId: "s-busy", seenAtMs: old },
        { sandboxId: "sb-orphan", sessionId: "s-ended", seenAtMs: old },
        { sandboxId: "sb-none", sessionId: null, seenAtMs: old },
      ],
      {
        "s-idle": { verdict: "armed", accountId: "acct" },
        "s-busy": { verdict: "keep", accountId: "acct" },
        "s-ended": { verdict: "orphan", accountId: "acct" },
      },
    );
    const counts = await sweepIdleSandboxes(env, now);
    expect(counts).toMatchObject({ armed: 1, keep: 1, orphan: 1, terminated: 1, unowned: 1 });
    expect(terminated).toEqual([
      { sessionId: "s-ended", body: { accountId: "acct", microvmId: "sb-orphan" } },
    ]);
  });

  it("gives a sandbox that may still be booting its grace", async () => {
    // Bound only once its create returns, a fresh sandbox reads as an orphan.
    const { env, terminated } = sweepEnv(
      [{ sandboxId: "sb-new", sessionId: "s-new", seenAtMs: now - 60_000 }],
      { "s-new": { verdict: "orphan", accountId: "acct" } },
    );
    const counts = await sweepIdleSandboxes(env, now);
    expect(counts).toMatchObject({ orphan: 1, terminated: 0 });
    expect(terminated).toEqual([]);
  });

  it("carries on past a session that cannot answer", async () => {
    const { env } = sweepEnv(
      [
        { sandboxId: "sb-a", sessionId: "s-broken", seenAtMs: old },
        { sandboxId: "sb-b", sessionId: "s-idle", seenAtMs: old },
      ],
      {
        "s-broken": new Error("overloaded"),
        "s-idle": { verdict: "armed", accountId: "acct" },
      },
    );
    const counts = await sweepIdleSandboxes(env, now);
    expect(counts).toMatchObject({ failed: 1, armed: 1 });
  });
});
