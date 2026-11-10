// The computer's Slack routes' telemetry (work 054, "Gateway"): where a
// message's trace starts (`message.received`) and the interaction spans
// (`interaction.received`). routes.ts calls these; durable-object.ts carries
// the rest (telemetry/computer.ts).

import type { ComputerEdgeEnv } from "../config.js";
import type { CalvinTraceContext } from "../protocol.js";
import type { SlackMessageJob } from "../slack.js";
import { uuidv7 } from "./envelope.js";
import { type GatewayTelemetry, SURFACE, gatewayTelemetry, mintTrace, traceFields } from "./gateway.js";

/** The Cloudflare colo that took the request (the gateway's `region`), when the runtime says. */
export function requestColo(request: Request): string | undefined {
  const colo = (request as Request & { cf?: { colo?: unknown } }).cf?.colo;
  return typeof colo === "string" && colo ? colo : undefined;
}

export interface ReceivedMessage {
  trace: CalvinTraceContext;
  t: GatewayTelemetry;
  /**
   * The organization the workspace is linked to is known: emit `message.received`
   * (and `message.ignored` when none), with which cache answered (team-cache.ts).
   */
  resolved(accountId: string | null, cached?: "memory" | "colo" | null): void;
}

/**
 * A verified, parsed Slack message: mint its trace (`sent_at` is Slack's
 * `ts`, `received_at` now) and prepare `message.received` with Slack's retry
 * headers. Emitted once the organization is resolved, so it carries `org_id`.
 */
export function receivedMessage(env: ComputerEdgeEnv, request: Request, job: SlackMessageJob): ReceivedMessage {
  const region = requestColo(request);
  const trace = mintTrace(env, job, region ? { region } : {});
  const t = gatewayTelemetry(env, { ...(region ? { region } : {}), base: traceFields(trace) });
  const retries = Number(request.headers.get("x-slack-retry-num") ?? 0) || 0;
  const reason = request.headers.get("x-slack-retry-reason");
  return {
    trace,
    t,
    resolved(accountId, cached = null) {
      const org = accountId ? { org_id: accountId } : {};
      t.emit("message.received", {
        ...org,
        duration_ms: trace.receivedAt - trace.sentAt,
        data: {
          surface_event_id: job.eventId,
          redelivery: retries > 0,
          ...(retries > 0 ? { redelivery_reason: reason || "unknown" } : {}),
          kind: job.mentioned ? "mention" : "message",
          ...(job.forwarded?.length ? { forwarded: job.forwarded.length } : {}),
          cached: cached !== null,
          ...(cached ? { cache_layer: cached } : {}),
          ...(region ? { colo: region } : {}),
        },
      });
      if (!accountId) t.emit("message.ignored", { data: { reason: "unlinked" } });
    },
  };
}

/**
 * `interaction.received`: a button, a secret modal or Slack's stop, timed
 * until the Durable Object call settles. Each starts its own trace. The
 * returned wrapper passes the work's result or error through unchanged.
 */
export function interactionSpan(
  env: ComputerEdgeEnv,
  request: Request,
  context: ExecutionContext,
  who: { teamId: string; accountId: string; userId?: string; channelId?: string },
) {
  return async <T>(kind: "action" | "secret" | "stop", work: Promise<T>): Promise<T> => {
    const region = requestColo(request);
    const t = gatewayTelemetry(env, {
      ...(region ? { region } : {}),
      base: {
        trace_id: uuidv7(),
        surface: SURFACE,
        surface_workspace_id: who.teamId,
        org_id: who.accountId,
        ...(who.userId ? { person_id: who.userId } : {}),
        ...(who.channelId ? { conversation_id: who.channelId } : {}),
      },
    });
    const span = t.start("interaction.received", { data: { kind } });
    try {
      const result = await work;
      span.end({ outcome: "completed" });
      return result;
    } catch (error) {
      span.end({ outcome: "failed", error_type: "unknown" });
      throw error;
    } finally {
      context.waitUntil(t.done());
    }
  };
}
