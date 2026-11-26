// Step-by-step latency of serverless agent sessions (work
// 073): one emitter per request, alarm or turn, on Calvin's Tinybird pipeline
// (src/computer/telemetry, work 054) under the `edge`, `session` and `workerd`
// services. Every event carries the managed session id as `session_key`, so a
// session's waterfall is one query, whichever Worker or object took each step.
//
// Invariants: as the gateway emitter's, telemetry never throws into or delays
// the work it measures; `time` returns or rethrows exactly what the work did.
// Without TINYBIRD_API_URL and TINYBIRD_APPEND_TOKEN nothing leaves.

import type { DataOf, EventName } from "../computer/telemetry/catalog.js";
import type { Span } from "../computer/telemetry/emitter.js";
import type { Dimensions } from "../computer/telemetry/envelope.js";
import {
  type GatewayTelemetry,
  gatewayTelemetry,
  type TelemetryEnv,
} from "../computer/telemetry/gateway.js";

export type LatencyService = "edge" | "session" | "workerd";

export interface Latency extends GatewayTelemetry {
  /** Fields stamped on every later event; set `session_key` here once a step learns it. */
  readonly base: Dimensions;
  /** Run `work` as the span `name`; a rejection ends it `failed` and is rethrown. */
  time<N extends EventName, T>(
    name: N,
    work: () => PromiseLike<T>,
    data?: (result: Awaited<T>) => DataOf<N>,
  ): Promise<Awaited<T>>;
  /** Send what was recorded without delaying the caller. */
  send(context?: { waitUntil(promise: Promise<unknown>): void }): void;
}

/** The Cloudflare colo that took the request, when the runtime says. */
export function requestRegion(request: Request): string | undefined {
  const colo = (request as Request & { cf?: { colo?: unknown } }).cf?.colo;
  return typeof colo === "string" && colo ? colo : undefined;
}

/** `env` is any Worker env; generated Env types omit the optional Tinybird settings. */
export function latencyTelemetry(
  env: object,
  service: LatencyService,
  base: Dimensions = {},
  region?: string,
): Latency {
  const t = gatewayTelemetry(env as TelemetryEnv, {
    service,
    base,
    ...(region ? { region } : {}),
  });
  return Object.assign(t, {
    base,
    async time<N extends EventName, T>(
      name: N,
      work: () => PromiseLike<T>,
      data?: (result: Awaited<T>) => DataOf<N>,
    ): Promise<Awaited<T>> {
      const span = t.start(name);
      let result: Awaited<T>;
      try {
        result = await work();
      } catch (error) {
        span.end({ outcome: "failed" });
        throw error;
      }
      let fields: DataOf<N> | undefined;
      try {
        fields = data?.(result);
      } catch {
        // A bad projection loses the data, not the span.
      }
      span.end(fields ? { data: fields } : {});
      return result;
    },
    send(context?: { waitUntil(promise: Promise<unknown>): void }) {
      const done = t.done();
      if (context) context.waitUntil(done);
    },
  });
}

/** Hooks for `proxyModelRequest`: upstream headers, then its first SSE event. */
export function upstreamTiming(
  latency: Latency,
  upstream: string,
  protocol: string,
): {
  upstreamResponded(status: number): void;
  firstEvent(bytes: number): void;
} {
  const responded = latency.start("model_gateway.upstream_responded");
  let first: Span<"model_gateway.first_event"> | undefined;
  return {
    upstreamResponded(status) {
      responded.end({ data: { status, upstream, protocol } });
      first = latency.start("model_gateway.first_event");
    },
    firstEvent(bytes) {
      first?.end({ data: { bytes } });
    },
  };
}
