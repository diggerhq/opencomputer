// Tail Worker — subscribes to console output and exception traces from
// other Workers in this account and POSTs them as JSON events to Axiom.
//
// Wire it up by adding to each producer Worker's wrangler.toml:
//   [[tail_consumers]]
//   service = "opensandbox-log-tail"
//
// Records are shaped to match the structure the cell/worker Go services
// already emit (level, msg, service, ...) so the dataset stays one schema
// regardless of producer.

interface Env {
  AXIOM_HOST: string;
  AXIOM_DATASET: string;
  AXIOM_TOKEN: string;
}

interface TraceLog {
  timestamp: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  message: unknown[];
}

interface TraceException {
  timestamp: number;
  name: string;
  message: string;
  stack?: string;
}

interface TraceItem {
  scriptName: string;
  outcome: "ok" | "exception" | "exceededCpu" | "exceededMemory" | "canceled" | "unknown";
  eventTimestamp?: number;
  event?: {
    request?: { url?: string; method?: string };
    response?: { status?: number };
    cron?: string;
    [k: string]: unknown;
  };
  logs: TraceLog[];
  exceptions: TraceException[];
  scriptVersion?: { id?: string };
}

function fmtMessage(parts: unknown[]): string {
  return redactWebhookTokens(
    parts
      .map((p) => (typeof p === "string" ? p : safeStringify(p)))
      .join(" "),
  );
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); }
  catch { return String(v); }
}

// Agent webhook URLs carry their credential after the webhook id (public
// `/api/agent-webhooks/<id>/<token>`, backend `/v1/agent-webhooks/<id>/<token>`).
// Everything after the id is redacted, whatever suffix a malformed request adds.
const WEBHOOK_TOKEN_PATH = /^(\/(?:api|v1)\/agent-webhooks\/[^/]+)\/.*$/;
// The same credential position anywhere in free text (a console message or
// an exception that quoted the path). Defense in depth: emitters redact too.
const WEBHOOK_TOKEN_IN_TEXT = /(\/(?:api|v1)\/agent-webhooks\/wh_[a-f0-9]{32})\/[^\s"'\\]+/g;

function redactWebhookTokens(text: string): string {
  return text.replace(WEBHOOK_TOKEN_IN_TEXT, "$1/redacted");
}

// Request query strings can carry browser client tokens (`?token=...`), and
// webhook paths carry the webhook credential. Keep the route useful for
// diagnostics without copying credentials into Axiom.
function requestUrlForLogs(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(WEBHOOK_TOKEN_PATH, "$1/redacted");
    return url.toString();
  } catch {
    return undefined;
  }
}

// Map CF console level → Axiom-friendly level string matching what our Go
// slog handler emits ("INFO", "WARN", "ERROR", "DEBUG").
function level(l: TraceLog["level"]): string {
  switch (l) {
    case "error": return "ERROR";
    case "warn":  return "WARN";
    case "debug": return "DEBUG";
    default:      return "INFO";
  }
}

// Workers that log one JSON object per line (blue's managed-agents Workers)
// get their correlation keys promoted to top-level fields, so a session, turn
// or computer is one `where` away. Only this fixed set is promoted: every
// distinct key becomes a dataset field and Axiom caps a dataset at 1024. The
// whole object stays in `msg`, queryable with parse_json().
const PROMOTED_FIELDS: Record<string, string> = {
  event: "event",
  sessionId: "session_id",
  sessionID: "session_id",
  session_id: "session_id",
  managedSessionId: "session_id",
  turnId: "turn_id",
  turn_id: "turn_id",
  hostTurnId: "turn_id",
  accountId: "account_id",
  account_id: "account_id",
  sandboxId: "sandbox_id",
  sandbox_id: "sandbox_id",
  generation: "generation",
  runtimeGeneration: "runtime_generation",
  reason: "reason",
  phase: "phase",
};

function structuredFields(parts: unknown[]): Record<string, unknown> {
  if (parts.length !== 1) return {};
  let value = parts[0];
  if (typeof value === "string") {
    if (!value.startsWith("{")) return {};
    try { value = JSON.parse(value); }
    catch { return {}; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(PROMOTED_FIELDS)) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      fields[field] ??= typeof v === "string" ? redactWebhookTokens(v) : v;
    }
  }
  const declared = (value as Record<string, unknown>).level;
  if (typeof declared === "string") {
    const upper = declared.toUpperCase();
    if (upper === "ERROR" || upper === "WARN" || upper === "INFO" || upper === "DEBUG") {
      fields.level = upper;
    }
  }
  return fields;
}

export default {
  async tail(items: TraceItem[], env: Env, _ctx: ExecutionContext): Promise<void> {
    const records: Record<string, unknown>[] = [];

    for (const item of items) {
      const baseEnvelope = {
        service: item.scriptName,
        service_id: item.scriptName,
        cell_id: "cf-edge",
        region: "global",
        outcome: item.outcome,
        request_url: requestUrlForLogs(item.event?.request?.url),
        request_method: item.event?.request?.method,
        response_status: item.event?.response?.status,
        cron: item.event?.cron,
        script_version: item.scriptVersion?.id,
      };

      for (const log of item.logs) {
        records.push({
          _time: new Date(log.timestamp).toISOString(),
          time: new Date(log.timestamp).toISOString(),
          level: level(log.level),
          msg: fmtMessage(log.message),
          ...structuredFields(log.message),
          ...baseEnvelope,
        });
      }

      for (const ex of item.exceptions) {
        records.push({
          _time: new Date(ex.timestamp).toISOString(),
          time: new Date(ex.timestamp).toISOString(),
          level: "ERROR",
          msg: redactWebhookTokens(`${ex.name}: ${ex.message}`),
          stack: ex.stack,
          ...baseEnvelope,
        });
      }

      // Synthetic record when a request failed without logging. A Worker can
      // catch an exception and return 5xx while Cloudflare still reports the
      // invocation outcome as "ok", so response status is part of the failure
      // contract too. This keeps silent server errors searchable in Axiom.
      const responseStatus = item.event?.response?.status;
      const serverError = typeof responseStatus === "number" && responseStatus >= 500;
      if ((item.outcome !== "ok" || serverError) && item.logs.length === 0 && item.exceptions.length === 0) {
        records.push({
          _time: new Date(item.eventTimestamp ?? Date.now()).toISOString(),
          time: new Date(item.eventTimestamp ?? Date.now()).toISOString(),
          level: "ERROR",
          msg: serverError
            ? `worker request returned HTTP ${responseStatus}`
            : `worker request ended with outcome=${item.outcome}`,
          ...baseEnvelope,
        });
      }
    }

    if (records.length === 0) return;

    const url = `${env.AXIOM_HOST}/v1/datasets/${env.AXIOM_DATASET}/ingest`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AXIOM_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(records),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const message = `axiom ingest failed status=${resp.status} body=${body.slice(0, 200)}`;
      console.error(message);
      // The collector has Cloudflare Workers Logs enabled as an independent
      // fallback. Throwing makes a broken durable sink an observable failed
      // invocation instead of an apparently healthy, lossy success.
      throw new Error(message);
    }
  },
};
