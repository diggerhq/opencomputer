import {
  proxyManagedAgents,
  type ManagedAgentsEnv,
} from "./managed_agents";

export interface SessionCostReportEnv extends ManagedAgentsEnv {
  OPENCOMPUTER_DB: D1Database;
}

interface ModelLedgerRow {
  org_name: string;
  model_markup_bps: number;
  committed_micro: number;
}

interface SessionCostRow {
  id: string;
  agentId: string;
  deploymentId: string;
  projectId?: string;
  projectName?: string;
  source: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  modelCalls: number;
  modelProviderCostUsd: number;
  runtimeSecondsByTier: Record<string, number>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function runtimeSeconds(value: unknown): Record<string, number> {
  const source = record(value) ?? {};
  return Object.fromEntries(
    Object.entries(source).flatMap(([tier, seconds]) => {
      const quantity = finiteNumber(seconds);
      return quantity >= 0 ? [[tier, quantity]] : [];
    }),
  );
}

function sessionCostRow(value: unknown): SessionCostRow | null {
  const source = record(value);
  if (
    !source ||
    typeof source.id !== "string" ||
    typeof source.agentId !== "string" ||
    typeof source.deploymentId !== "string" ||
    typeof source.source !== "string" ||
    typeof source.status !== "string" ||
    typeof source.createdAt !== "string" ||
    typeof source.updatedAt !== "string"
  ) {
    return null;
  }
  const projectId = optionalString(source.projectId);
  const projectName = optionalString(source.projectName);
  return {
    id: source.id,
    agentId: source.agentId,
    deploymentId: source.deploymentId,
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    source: source.source,
    status: source.status,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    modelCalls: Math.max(0, finiteNumber(source.modelCalls)),
    modelProviderCostUsd: Math.max(
      0,
      finiteNumber(source.modelProviderCostUsd),
    ),
    runtimeSecondsByTier: runtimeSeconds(source.runtimeSecondsByTier),
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Produces an operator-only attribution report without exposing prompts, event
 * bodies, credentials, or customer-auth material. The managed-agent backend is
 * the session-level display ledger; D1's OpenRouter watermark remains the
 * organization-level billing reconciliation point.
 */
export async function sessionCostReport(
  env: SessionCostReportEnv,
  orgID: string,
  requestedLimit: number,
): Promise<Response> {
  const limit = Math.max(1, Math.min(Math.floor(requestedLimit) || 100, 100));
  const ledger = await env.OPENCOMPUTER_DB.prepare(
    `SELECT o.name AS org_name,
            o.model_markup_bps AS model_markup_bps,
            COALESCE(SUM(k.committed_micro), 0) AS committed_micro
       FROM orgs o
       LEFT JOIN managed_model_keys k
         ON k.org_id = o.id
        AND k.status IN ('active', 'superseded', 'deleting')
      WHERE o.id = ?1
      GROUP BY o.id, o.name, o.model_markup_bps`,
  )
    .bind(orgID)
    .first<ModelLedgerRow>();
  if (!ledger) return json({ error: "org not found" }, 404);

  const upstreamRequest = new Request(
    `https://app.opencomputer.dev/api/managed-agents/billing/sessions?limit=${limit}`,
  );
  const upstream = await proxyManagedAgents(
    upstreamRequest,
    env,
    { orgID, userID: null },
    "/api/managed-agents",
  );
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  }

  const body = record(await upstream.json().catch(() => null));
  if (!body || !Array.isArray(body.sessions)) {
    return json({ error: "managed-agent usage response was invalid" }, 502);
  }
  const sessions = body.sessions
    .map(sessionCostRow)
    .filter((row): row is SessionCostRow => row !== null)
    .sort((left, right) =>
      right.modelProviderCostUsd - left.modelProviderCostUsd ||
      right.updatedAt.localeCompare(left.updatedAt),
    );
  const attributedProviderCostUsd = sessions.reduce(
    (total, session) => total + session.modelProviderCostUsd,
    0,
  );
  const committedProviderCostUsd = ledger.committed_micro / 1_000_000;
  const markupMultiplier = 1 + ledger.model_markup_bps / 10_000;

  return json({
    orgId: orgID,
    orgName: ledger.org_name,
    generatedAt: new Date().toISOString(),
    coverage: {
      requestedSessionLimit: limit,
      returnedSessions: sessions.length,
      possiblyTruncated: sessions.length === limit,
    },
    reconciliation: {
      attributedProviderCostUsd,
      committedProviderCostUsd,
      unattributedProviderCostUsd:
        committedProviderCostUsd - attributedProviderCostUsd,
      markupBps: ledger.model_markup_bps,
      attributedBilledCostUsd:
        attributedProviderCostUsd * markupMultiplier,
      committedBilledCostUsd: committedProviderCostUsd * markupMultiplier,
    },
    sessions,
  });
}
