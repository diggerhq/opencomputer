import {
  handleAutumnBilling,
  type DashboardEnv,
} from "./dashboard";
import { proxyManagedAgents } from "./managed_agents";

export type DataAnalystEnv = DashboardEnv & {
  DATA_ANALYST_API_TOKEN?: string;
};

const DATA_ANALYST_PREFIX = "/api/internal/data-analyst/orgs/";
const MAX_SESSION_ROWS = 100;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export async function dataAnalystTokenMatches(
  candidate: string,
  expected: string,
): Promise<boolean> {
  const [candidateDigest, expectedDigest] = await Promise.all([
    sha256(candidate),
    sha256(expected),
  ]);
  let mismatch = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    mismatch |= candidateDigest[index] ^ expectedDigest[index];
  }
  return mismatch === 0;
}

async function authenticateDataAnalyst(
  request: Request,
  env: DataAnalystEnv,
): Promise<boolean> {
  if (!env.DATA_ANALYST_API_TOKEN) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const candidate = authorization.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "";
  return dataAnalystTokenMatches(candidate, env.DATA_ANALYST_API_TOKEN);
}

function boundedLimit(url: URL): number {
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(requested, MAX_SESSION_ROWS))
    : 50;
}

export async function annotateBillingResponse(
  response: Response,
  orgId: string,
  observedAt: string,
): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.json<Record<string, unknown>>();
  return json({ orgId, observedAt, ...body });
}

async function sessionsResponse(
  request: Request,
  env: DataAnalystEnv,
  orgId: string,
  observedAt: string,
): Promise<Response> {
  const sourceURL = new URL(request.url);
  const limit = boundedLimit(sourceURL);
  const includePreview = sourceURL.searchParams.get("include_preview") === "true";
  const upstreamURL = new URL(
    "/api/managed-agents/billing/sessions",
    sourceURL.origin,
  );
  upstreamURL.searchParams.set("limit", String(limit));
  const upstream = await proxyManagedAgents(
    new Request(upstreamURL, {
      method: "GET",
      headers: { accept: "application/json" },
    }),
    env,
    { orgID: orgId, userID: null },
    "/api/managed-agents",
  );
  if (!upstream.ok) return upstream;
  const body = await upstream.json<{ sessions?: unknown[] }>();
  const sessions = Array.isArray(body.sessions)
    ? body.sessions.map((value) => {
        if (
          includePreview ||
          !value ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          return value;
        }
        const { title: _title, ...withoutPreview } = value as Record<
          string,
          unknown
        >;
        return withoutPreview;
      })
    : [];
  return json({ orgId, observedAt, sessions });
}

export async function handleDataAnalystAPI(
  request: Request,
  env: DataAnalystEnv,
  path: string,
): Promise<Response> {
  if (!env.DATA_ANALYST_API_TOKEN) {
    return json({ error: "not found" }, 404);
  }
  if (!(await authenticateDataAnalyst(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!path.startsWith(DATA_ANALYST_PREFIX)) {
    return json({ error: "not found" }, 404);
  }
  const suffix = path.slice(DATA_ANALYST_PREFIX.length);
  const separator = suffix.lastIndexOf("/");
  if (separator <= 0) return json({ error: "not found" }, 404);
  let orgId: string;
  try {
    orgId = decodeURIComponent(suffix.slice(0, separator));
  } catch {
    return json({ error: "not found" }, 404);
  }
  if (!orgId || orgId.length > 256 || orgId.includes("/")) {
    return json({ error: "not found" }, 404);
  }
  const resource = suffix.slice(separator + 1);
  const observedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      event: "data_analyst.read",
      orgId,
      resource,
      ...(resource === "sessions"
        ? {
            includePreview:
              new URL(request.url).searchParams.get("include_preview") ===
              "true",
          }
        : {}),
    }),
  );
  if (resource === "billing") {
    return annotateBillingResponse(
      await handleAutumnBilling(request, env, { orgID: orgId }),
      orgId,
      observedAt,
    );
  }
  if (resource === "sessions") {
    return sessionsResponse(request, env, orgId, observedAt);
  }
  return json({ error: "not found" }, 404);
}
