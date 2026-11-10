// The computer gateway's telemetry (work 054, "Gateway →
// Tinybird"; ported from dash-cal#17 src/telemetry/gateway.ts). One emitter
// per Worker request, Durable Object alarm job, RPC call or WebSocket message,
// ending with `waitUntil(t.done())`. The batch goes straight to Tinybird's
// Events API with the gateway's own append token: one POST per datasource per
// invocation, one retry on 5xx, 429 or timeout, then the records are dropped
// and counted.
//
// Invariants: nothing here throws into a handler or delays a response. With
// TINYBIRD_API_URL or TINYBIRD_APPEND_TOKEN unset (decision 1: the secret's
// presence is the switch) the emitter validates and discards, `wait` keeps
// nothing open and `done` makes no request.

import type { CalvinTraceContext } from "../protocol.js";
import type { ServiceName } from "./catalog.js";
import { type Batch, createTelemetry, type Telemetry } from "./emitter.js";
import { type Dimensions, eventLine, tbTime, uuidv7 } from "./envelope.js";

export const SURFACE = "slack";
/** How long `done` waits for work it was asked to wait for (an acknowledgement) before sending without it. */
const WAIT_MS = 10_000;
const POST_TIMEOUT_MS = 5_000;

/** The settings telemetry reads; all optional (config.ts ComputerEdgeEnv declares them). */
export interface TelemetryEnv {
  TINYBIRD_API_URL?: string;
  TINYBIRD_APPEND_TOKEN?: string;
  CF_VERSION_METADATA?: { id?: string };
}

export interface GatewayTelemetry extends Telemetry {
  /** Whether batches leave the process (both Tinybird settings present). */
  readonly enabled: boolean;
  /** Keep this invocation's batch open until `work` settles (at most 10 s). No-op when disabled. */
  wait(work: Promise<unknown>): void;
  /** Wait for that work, then send the batch. Never rejects; hand it to `waitUntil`. */
  done(): Promise<void>;
}

export interface GatewayTelemetryOptions {
  /** The emitting service; `gateway` unless a serverless-session span (work 073). */
  service?: ServiceName;
  /** The Cloudflare colo that took the request, when known. */
  region?: string;
  synthetic?: boolean;
  base?: Dimensions;
  fetch?: typeof fetch;
}

/** The deployed Worker version, or `dev` without the version metadata binding. */
export function gatewayVersion(env: TelemetryEnv): string {
  return env.CF_VERSION_METADATA?.id || "dev";
}

export function telemetryEnabled(env: TelemetryEnv): boolean {
  return Boolean(env.TINYBIRD_API_URL?.trim() && env.TINYBIRD_APPEND_TOKEN?.trim());
}

export function gatewayTelemetry(env: TelemetryEnv, o: GatewayTelemetryOptions = {}): GatewayTelemetry {
  const enabled = telemetryEnabled(env);
  const url = env.TINYBIRD_API_URL?.trim().replace(/\/+$/, "");
  const token = env.TINYBIRD_APPEND_TOKEN?.trim();
  const post = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const t = createTelemetry({
    service: o.service ?? "gateway",
    version: gatewayVersion(env),
    region: o.region || "unknown",
    ...(enabled && url && token ? { send: (batch: Batch) => sendBatch(post, url, token, batch) } : {}),
    ...(o.base ? { base: o.base } : {}),
    ...(o.synthetic ? { synthetic: true } : {}),
  });
  const waiting: Promise<unknown>[] = [];
  return {
    enabled,
    emit: t.emit,
    start: t.start,
    turn: t.turn,
    flush: t.flush,
    get buffered() {
      return t.buffered;
    },
    get dropped() {
      return t.dropped;
    },
    wait(work) {
      if (enabled) waiting.push(work.catch(() => {}));
    },
    async done() {
      try {
        if (!enabled) return void (await t.flush());
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.all(waiting), new Promise<void>((resolve) => (timer = setTimeout(resolve, WAIT_MS)))]);
        if (timer !== undefined) clearTimeout(timer);
        const before = t.dropped.send_failed ?? 0;
        await t.flush();
        // A per-invocation emitter has no next flush to report this on; Workers Logs keeps the count.
        const failed = (t.dropped.send_failed ?? 0) - before;
        if (failed) console.warn(JSON.stringify({ level: "warn", event: "computer.telemetry_send_failed", records: failed }));
      } catch {
        // Telemetry never fails the work it measures.
      }
    },
  };
}

/** POST one datasource's NDJSON: 5xx, 429 and timeouts are retried once; anything else throws (counted by the emitter). */
async function postLines(post: typeof fetch, url: string, token: string, datasource: string, lines: string[]): Promise<void> {
  const target = `${url}/v0/events?name=${datasource}&wait=false`;
  for (let attempt = 1; ; attempt++) {
    let status: number;
    try {
      const response = await post(target, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
        body: lines.join("\n"),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return;
      status = response.status;
    } catch (error) {
      if (attempt >= 2) throw error;
      continue;
    }
    if (attempt >= 2 || (status < 500 && status !== 429)) throw new Error(`tinybird_${status}`);
  }
}

async function sendBatch(post: typeof fetch, url: string, token: string, batch: Batch): Promise<void> {
  if (batch.events.length) await postLines(post, url, token, "calvin_events", batch.events.map(eventLine));
  if (batch.turns.length) await postLines(post, url, token, "calvin_turns", batch.turns.map((row) => JSON.stringify(row)));
}

// ---------------------------------------------------------------- trace context

/** Slack's `ts` (`1791840900.000100`) as ms since epoch. */
export function slackTsMs(ts: string): number {
  const ms = Math.round(Number(ts) * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : Date.now();
}

/** What a trace is minted from: a Slack message the gateway took in (or a message a secret submission sends). */
export interface TraceSource {
  teamId: string;
  channelId: string;
  userId: string;
  messageTs: string;
  receivedAt: number;
  eventId?: string;
}

/** A new trace (`message.received`): Slack's time for the message, ours for receiving it. */
export function mintTrace(env: TelemetryEnv, job: TraceSource, o: { region?: string; synthetic?: boolean } = {}): CalvinTraceContext {
  return {
    id: uuidv7(job.receivedAt),
    sentAt: slackTsMs(job.messageTs),
    receivedAt: job.receivedAt,
    surface: SURFACE,
    surfaceWorkspaceId: job.teamId,
    conversationId: job.channelId,
    personId: job.userId,
    ...(job.eventId ? { surfaceEventId: job.eventId } : {}),
    gatewayVersion: gatewayVersion(env),
    ...(o.region ? { gatewayRegion: o.region } : {}),
    ...(o.synthetic ? { synthetic: true } : {}),
  };
}

/** The envelope fields a trace gives every event of it. */
export function traceFields(trace: CalvinTraceContext | undefined): Dimensions {
  if (!trace) return {};
  return {
    trace_id: trace.id,
    surface: trace.surface,
    surface_workspace_id: trace.surfaceWorkspaceId,
    conversation_id: trace.conversationId,
    person_id: trace.personId,
    sent_at: tbTime(trace.sentAt),
    ...(trace.gatewaySessionId ? { gateway_session_id: trace.gatewaySessionId } : {}),
  };
}

/** An emitter for one invocation's work on one trace: its fields on every event. */
export function traceTelemetry(env: TelemetryEnv, trace: CalvinTraceContext | undefined, base: Dimensions = {}): GatewayTelemetry {
  return gatewayTelemetry(env, {
    ...(trace?.gatewayRegion ? { region: trace.gatewayRegion } : {}),
    ...(trace?.synthetic ? { synthetic: true } : {}),
    base: { ...traceFields(trace), ...base },
  });
}
