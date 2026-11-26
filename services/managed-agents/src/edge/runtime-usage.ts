// Agent runtime usage: one closed, bounded segment of billed runtime posted to
// the public edge (opencomputer api-edge `/internal/agent-runtime-usage`),
// which tracks it against the organization's `agent_runtime_2gb_1vcpu`
// feature in Autumn. Shared by serverless agent sessions (SessionDurableObject's
// runtime billing lease) and computer sessions (work 052, src/computer/billing.ts),
// so both bill the same feature through the same signed request.
//
// The segment's ID is the financial idempotency key: Autumn drops a repeat,
// so a delivery retried after a lost response never bills twice.

export const AGENT_RUNTIME_USAGE_PATH = "/internal/agent-runtime-usage";

/** The only tier the edge accepts; it, not the caller, selects the Autumn feature. */
export const AGENT_RUNTIME_RESOURCE_TIER = "2gb_1vcpu" as const;

export interface AgentRuntimeUsageConfig {
  OPENCOMPUTER_APP_URL?: string;
  BLUE_USAGE_HMAC_SECRET?: string;
}

export interface AgentRuntimeUsage {
  orgId: string;
  deploymentId: string;
  agentId: string;
  sessionId: string;
  microvmId: string;
  quantitySeconds: number;
  startedAtMs: number;
  endedAtMs: number;
  closeReason: string;
  /** The segment's ID: the same segment always posts the same key. */
  idempotencyKey: string;
}

/** Whether segments can be delivered at all; undelivered segments stay pending until they can. */
export function agentRuntimeUsageConfigured(config: AgentRuntimeUsageConfig): boolean {
  return Boolean(config.OPENCOMPUTER_APP_URL && config.BLUE_USAGE_HMAC_SECRET);
}

/** Backoff after a failed delivery: 2, 4, 8 … seconds, at most five minutes. */
export function agentRuntimeUsageRetryAt(attempts: number, nowMs: number): number {
  return nowMs + Math.min(300_000, 2 ** attempts * 1_000);
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Posts one segment, signed `${timestamp}.${path}.${body}` with
 * BLUE_USAGE_HMAC_SECRET (the edge's AGENT_RUNTIME_USAGE_HMAC_SECRET).
 * Resolves when the edge accepted it; throws otherwise, and the caller
 * retries the same segment later.
 */
export async function postAgentRuntimeUsage(
  config: AgentRuntimeUsageConfig,
  usage: AgentRuntimeUsage,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!config.OPENCOMPUTER_APP_URL || !config.BLUE_USAGE_HMAC_SECRET) {
    throw new Error("agent runtime usage delivery is not configured");
  }
  const endpoint = new URL(AGENT_RUNTIME_USAGE_PATH, config.OPENCOMPUTER_APP_URL);
  const body = JSON.stringify({
    org_id: usage.orgId,
    deployment_id: usage.deploymentId,
    agent_id: usage.agentId,
    session_id: usage.sessionId,
    microvm_id: usage.microvmId,
    resource_tier: AGENT_RUNTIME_RESOURCE_TIER,
    quantity_seconds: usage.quantitySeconds,
    segment_started_at: new Date(usage.startedAtMs).toISOString(),
    segment_ended_at: new Date(usage.endedAtMs).toISOString(),
    close_reason: usage.closeReason,
    idempotency_key: usage.idempotencyKey,
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await hmacSha256Hex(config.BLUE_USAGE_HMAC_SECRET, `${timestamp}.${endpoint.pathname}.${body}`);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`usage endpoint returned ${response.status}`);
  }
}
