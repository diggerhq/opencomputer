// Billing funnel events (serverless-agents-ws 086, "Funnel events"): the same
// event, by name, to Tinybird (`calvin_events`, the envelope edge.request uses;
// catalogued as `edge` entries in blue's src/computer/telemetry/catalog.ts) and
// to PostHog, keyed by org id plus the user id where there is one.
//
// Each sink is off unless configured: TINYBIRD_API_URL + TINYBIRD_APPEND_TOKEN,
// and POSTHOG_PROJECT_TOKEN (POSTHOG_HOST defaults to PostHog US). Never throws,
// never retries; one attempt per sink, bounded, so a billing path can await it.
//
// Data policy (work 054): ids and scalars only, never emails or amounts tied
// to a card.

import { edgeTelemetryEnabled, tbTime, uuidv7, type EdgeTelemetryEnv } from "./computer_telemetry";

export interface BillingEventsEnv extends EdgeTelemetryEnv {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
}

export type BillingEventName =
  | "billing.trial_started"
  | "billing.work_minutes_recorded"
  | "billing.first_work_minute"
  | "billing.checkout_opened";

export interface BillingEvent {
  orgId: string;
  userId?: string;
  data: Record<string, string | number | boolean | null>;
}

const POST_TIMEOUT_MS = 2_000;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** The Tinybird line for one billing event. */
export function billingTinybirdEvent(
  env: BillingEventsEnv,
  name: BillingEventName,
  event: BillingEvent,
  now = Date.now(),
): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: uuidv7(now),
    event_name: name,
    occurred_at: tbTime(now),
    service_name: "edge",
    service_version: env.CF_VERSION_METADATA?.id || "dev",
    region: "unknown",
    synthetic: false,
    surface: "api",
    org_id: event.orgId,
    ...(event.userId ? { user_id: event.userId } : {}),
    outcome: "completed",
    data: JSON.stringify(withoutNulls(event.data)),
  };
}

/** The PostHog capture body for one billing event. */
export function billingPostHogEvent(
  token: string,
  name: BillingEventName,
  event: BillingEvent,
  now = Date.now(),
): Record<string, unknown> {
  return {
    api_key: token,
    event: name,
    // The web app identifies people by user id; an event with no user (a
    // usage record) is the org's own.
    distinct_id: event.userId ?? `org:${event.orgId}`,
    timestamp: new Date(now).toISOString(),
    properties: {
      ...withoutNulls(event.data),
      org_id: event.orgId,
      $groups: { organization: event.orgId },
      ...(event.userId ? {} : { $process_person_profile: false }),
    },
  };
}

export async function emitBillingEvent(
  env: BillingEventsEnv,
  name: BillingEventName,
  event: BillingEvent,
): Promise<void> {
  const now = Date.now();
  const sends: Promise<unknown>[] = [];
  try {
    if (edgeTelemetryEnabled(env)) {
      sends.push(
        post(
          `${env.TINYBIRD_API_URL!.trim().replace(/\/+$/, "")}/v0/events?name=calvin_events&wait=false`,
          { authorization: `Bearer ${env.TINYBIRD_APPEND_TOKEN!.trim()}`, "content-type": "application/x-ndjson" },
          JSON.stringify(billingTinybirdEvent(env, name, event, now)),
        ),
      );
    }
    const token = env.POSTHOG_PROJECT_TOKEN?.trim();
    if (token) {
      sends.push(
        post(
          `${(env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "")}/i/v0/e/`,
          { "content-type": "application/json" },
          JSON.stringify(billingPostHogEvent(token, name, event, now)),
        ),
      );
    }
  } catch {
    // Telemetry never fails the billing path.
  }
  await Promise.allSettled(sends);
}

async function post(url: string, headers: Record<string, string>, body: string): Promise<void> {
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
  await res.body?.cancel().catch(() => {});
}

function withoutNulls(data: BillingEvent["data"]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
