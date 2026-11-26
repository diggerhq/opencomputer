import type { SessionDurableObject } from "./session-do.js";

/**
 * A sandbox the shim has known for less than this may still be booting: its
 * session binds it only once the create returns, so until then it reads as
 * bound elsewhere. Creates time out well inside it.
 */
export const SWEEP_ORPHAN_GRACE_MS = 15 * 60_000;
const SWEEP_CONCURRENCY = 8;

export interface SandboxSweepEnv {
  RUNTIMES?: Fetcher;
  SESSIONS: DurableObjectNamespace<SessionDurableObject>;
}

interface LiveSandbox {
  sandboxId: string;
  sessionId: string | null;
  seenAtMs: number;
}

export type SandboxSweepCounts = Record<
  "armed" | "waiting" | "keep" | "orphan" | "terminated" | "unowned" | "failed",
  number
>;

/**
 * The backstop for idle suspend. A session arms its own idle suspend when a
 * turn settles; a sandbox that missed that moment, or whose session moved on
 * without it, would otherwise run to its 24 hour lifetime cap. Every running
 * Modal sandbox is put to its session: one that is idle gets its deadline
 * armed (the session suspends it on its own alarm, snapshot and all), and one
 * no session will ever let go of is terminated.
 */
export async function sweepIdleSandboxes(
  env: SandboxSweepEnv,
  now = Date.now(),
): Promise<SandboxSweepCounts | undefined> {
  if (!env.RUNTIMES) return undefined;
  const runtimes = env.RUNTIMES;
  const response = await runtimes.fetch("https://blue-runtime/v1/sandboxes/live");
  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "sandbox_sweep.list_failed",
        status: response.status,
      }),
    );
    return undefined;
  }
  const { sandboxes } = (await response.json()) as { sandboxes: LiveSandbox[] };
  const counts: SandboxSweepCounts = {
    armed: 0,
    waiting: 0,
    keep: 0,
    orphan: 0,
    terminated: 0,
    unowned: 0,
    failed: 0,
  };

  const sweepOne = async (sandbox: LiveSandbox): Promise<void> => {
    // Created without a session (or before the shim recorded one): nothing to
    // ask, and the lifetime cap still holds.
    if (!sandbox.sessionId) {
      counts.unowned++;
      return;
    }
    const sessionId = sandbox.sessionId;
    try {
      const { verdict, accountId } = await env.SESSIONS.getByName(
        sessionId,
      ).sweepRuntime(sandbox.sandboxId);
      counts[verdict]++;
      if (
        verdict !== "orphan" ||
        !accountId ||
        now - sandbox.seenAtMs < SWEEP_ORPHAN_GRACE_MS
      ) {
        return;
      }
      const terminated = await runtimes.fetch(
        `https://blue-runtime/v1/sessions/${encodeURIComponent(sessionId)}/terminate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId, microvmId: sandbox.sandboxId }),
        },
      );
      if (!terminated.ok) throw new Error(`runtime returned ${String(terminated.status)}`);
      counts.terminated++;
      console.log(
        JSON.stringify({
          event: "sandbox_sweep.orphan_terminated",
          sessionId,
          sandboxId: sandbox.sandboxId,
        }),
      );
    } catch (error) {
      counts.failed++;
      console.error(
        JSON.stringify({
          level: "warn",
          event: "sandbox_sweep.sandbox_failed",
          sessionId,
          sandboxId: sandbox.sandboxId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const queue = [...sandboxes];
  await Promise.all(
    Array.from({ length: SWEEP_CONCURRENCY }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await sweepOne(next);
      }
    }),
  );
  console.log(
    JSON.stringify({ event: "sandbox_sweep.done", live: sandboxes.length, ...counts }),
  );
  return counts;
}
