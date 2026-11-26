import type { AgentDeployment, SessionSnapshot } from "../protocol.js";
import type { RuntimeLaunchEnv } from "./runtime-launch.js";
import type { SessionDurableObject } from "./session-do.js";

/**
 * Start a sandbox session's runtime (the DO-first start, work 078): claim the
 * start on the session, ask the runtime service for a sandbox, and bind it.
 * The claim is the session's, so a second caller is a no-op while a start is
 * in flight or a runtime is bound, and a Workerd session never claims. A
 * failure releases the claim for the next caller and is logged, never thrown.
 *
 * Every path that creates a sandbox session or gives it a turn must call
 * this: the HTTP create and turn routes, and the account's own launches
 * (schedule firings, deferred webhooks). Nothing else boots the runtime.
 */
export async function startSandboxSessionRuntime(
  env: RuntimeLaunchEnv,
  input: {
    accountId: string;
    session: DurableObjectStub<SessionDurableObject>;
    edge: string;
    /** The session's pinned deployment, with its runtime profile applied, and its project. */
    configuration(
      snapshot: SessionSnapshot,
    ): Promise<{ projectId: string; deployment: AgentDeployment }>;
  },
): Promise<void> {
  const { accountId, session, edge } = input;
  const claim = await session.claimRuntimeStart();
  if (!claim.claimed) return;
  const startedAt = Date.now();
  try {
    const snapshot = (await session.snapshot()) as SessionSnapshot;
    const { projectId, deployment: runtimeDeployment } =
      await input.configuration(snapshot);
    console.log(
      JSON.stringify({
        level: "info",
        event: "runtime.lazy_configuration_loaded",
        sessionId: snapshot.id,
        deploymentId: runtimeDeployment.id,
        artifactDigest: runtimeDeployment.artifact.digest,
        imageVersion: runtimeDeployment.imageVersion,
        configurationMs: Date.now() - startedAt,
      }),
    );
    await session.recordRuntimeStartProgress(
      claim.attempt,
      "configuration_loaded",
      {
        deploymentId: runtimeDeployment.id,
        configurationMs: Date.now() - startedAt,
      },
    );
    if (!env.RUNTIMES) {
      throw new Error("The managed-agent runtime service is not configured");
    }
    await session.recordRuntimeStartProgress(claim.attempt, "runtime_requested");
    const response = await env.RUNTIMES.fetch(
      "https://blue-runtime/v1/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId,
          projectId,
          sessionId: snapshot.id,
          runtimeToken: claim.runtimeToken,
          edge,
          deployment: runtimeDeployment,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Runtime start failed (${response.status})`);
    }
    const runtime = (await response.json()) as {
      microvmId?: unknown;
      provider?: unknown;
    };
    if (typeof runtime.microvmId !== "string") {
      throw new Error("Runtime service did not return a MicroVM ID");
    }
    // The platform names the provider that launched the runtime (work 078);
    // an AWS platform predating that field launched a Lambda MicroVM.
    const provider = runtime.provider === "modal" ? "modal" : "aws";
    const elapsedMs = Date.now() - startedAt;
    // The event is public: no provider or runtime id, only the timing.
    // The console log below keeps both for operators.
    await session.recordRuntimeStartProgress(claim.attempt, "runtime_started", {
      elapsedMs,
      message: `Agent runtime started in a sandbox · ${elapsedMs} ms`,
    });
    await session.bindMicrovm({
      microvmId: runtime.microvmId,
      state: "running",
    });
    console.log(
      JSON.stringify({
        level: "info",
        event: "runtime.lazy_start_requested",
        sessionId: snapshot.id,
        deploymentId: runtimeDeployment.id,
        provider,
        microvmId: runtime.microvmId,
        elapsedMs,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await session.releaseRuntimeStart(claim.attempt, message);
    console.error(
      JSON.stringify({
        level: "error",
        event: "runtime.lazy_start_failed",
        sessionId: (await session.snapshot()).id,
        attempt: claim.attempt,
        elapsedMs: Date.now() - startedAt,
        message,
      }),
    );
  }
}
