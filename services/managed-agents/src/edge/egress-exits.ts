/**
 * Fixed egress exits, control plane side (work 073).
 * A deployment with fixed IPs has a row in D1 naming its exit region and
 * allowlist. Each exit (`deploy/egress/`) polls its region's policy here
 * every minute and applies changes live; the public IP list is served from
 * the registry `deploy/egress/apply.sh` writes.
 */
import { parseDeploymentEgress, platformEgressDomains } from "../deployment-egress.js";
import { egressExitPool, egressExitPools, egressExitsFor, exitIdentity, fixedIpsRegions } from "../egress-exit.js";
import type { DeploymentEgress } from "../protocol.js";

export { EGRESS_EXITS, egressExitPools, egressExitsFor, fixedIpsRegions } from "../egress-exit.js";

export interface EgressExitEnv {
  SERVERLESS_AGENTS_DB: D1Database;
  /** Comma-separated bearer tokens the exits poll with, current first. */
  EGRESS_FETCH_TOKENS?: string;
  /** The artifact bucket's region, for the platform hosts every sandbox needs. */
  BLUE_AWS_REGION?: string;
}

/**
 * A deploy's `fixedIps`: undefined when absent, null when not a region with
 * exits.
 */
export function parseFixedIps(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && egressExitsFor(value).length > 0 ? value : null;
}

/**
 * Records that a deployment's sandboxes leave through `region`'s exits, with
 * its allowlist (absent is an open network). A redeploy replaces the row.
 */
export async function recordEgressExit(
  env: Pick<EgressExitEnv, "SERVERLESS_AGENTS_DB">,
  input: { accountId: string; deploymentId: string; region: string; egress?: DeploymentEgress },
): Promise<void> {
  if (egressExitsFor(input.region).length === 0) throw new Error(`No egress exits in region ${input.region}`);
  await env.SERVERLESS_AGENTS_DB.prepare(
    `INSERT INTO egress_exit_deployments
       (account_id, deployment_id, exit_id, exit_region, egress, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, deployment_id) DO UPDATE SET
       exit_region = excluded.exit_region, egress = excluded.egress, updated_at = excluded.updated_at`,
  )
    .bind(
      input.accountId,
      input.deploymentId,
      await exitIdentity(input.accountId, input.deploymentId),
      egressExitPool(input.region),
      input.egress ? JSON.stringify(input.egress) : null,
      new Date().toISOString(),
    )
    .run();
}

/** Takes a deployment off the exits (it no longer has fixed IPs). */
export async function forgetEgressExit(
  env: Pick<EgressExitEnv, "SERVERLESS_AGENTS_DB">,
  input: { accountId: string; deploymentId: string },
): Promise<void> {
  await env.SERVERLESS_AGENTS_DB.prepare(
    "DELETE FROM egress_exit_deployments WHERE account_id = ? AND deployment_id = ?",
  )
    .bind(input.accountId, input.deploymentId)
    .run();
}

/**
 * The policy an exit in `region` enforces, in the shape `egress.py` reads:
 * exit id to null (open) or the allowlist plus the platform's own hosts, as
 * on Modal. A stored allowlist that no longer parses fails closed.
 */
export async function egressExitPolicy(
  env: Pick<EgressExitEnv, "SERVERLESS_AGENTS_DB">,
  region: string,
  platformDomains: string[],
): Promise<{ deployments: Record<string, DeploymentEgress | null> }> {
  const { results } = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT exit_id, egress FROM egress_exit_deployments WHERE exit_region = ? ORDER BY exit_id",
  )
    .bind(region)
    .all<{ exit_id: string; egress: string | null }>();
  const deployments: Record<string, DeploymentEgress | null> = {};
  for (const row of results) {
    if (row.egress === null) {
      deployments[row.exit_id] = null;
      continue;
    }
    let stored: DeploymentEgress | null | undefined = null;
    try {
      stored = parseDeploymentEgress(JSON.parse(row.egress));
    } catch {
      stored = null;
    }
    deployments[row.exit_id] = {
      domains: [...new Set([...(stored?.domains ?? []), ...platformDomains])].sort(),
      cidrs: stored?.cidrs ?? [],
    };
  }
  return { deployments };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchTokenValid(env: EgressExitEnv, authorization: string | null): Promise<boolean> {
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const configured = (env.EGRESS_FETCH_TOKENS ?? "").split(",").map((token) => token.trim()).filter(Boolean);
  if (!provided || configured.length === 0) return false;
  // Compare digests in full, so the time taken does not depend on the token.
  const providedHash = await sha256Hex(provided);
  let valid = false;
  for (const token of configured) {
    const configuredHash = await sha256Hex(token);
    let difference = 0;
    for (let index = 0; index < configuredHash.length; index += 1) {
      difference |= configuredHash.charCodeAt(index) ^ providedHash.charCodeAt(index);
    }
    valid = difference === 0 || valid;
  }
  return valid;
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * `GET /internal/egress/policy?region=<region>` with the exits' bearer token.
 * Answers 304 to a matching `If-None-Match`, so a minute's poll is cheap.
 * The platform hosts are this edge's own and the artifact bucket's, so exits
 * must poll the same hostname sandboxes reach the edge by.
 */
export async function egressPolicyResponse(request: Request, env: EgressExitEnv): Promise<Response> {
  if (request.method !== "GET") return problem(405, "method_not_allowed", "Method not allowed");
  if (!env.EGRESS_FETCH_TOKENS || !env.BLUE_AWS_REGION) {
    return problem(503, "not_configured", "Egress exits are not configured");
  }
  if (!(await fetchTokenValid(env, request.headers.get("authorization")))) {
    return problem(401, "unauthorized", "Invalid exit credential");
  }
  const url = new URL(request.url);
  const region = url.searchParams.get("region") ?? "";
  if (!egressExitPools().includes(region)) return problem(400, "invalid_region", "Unknown exit region");
  const body = JSON.stringify(
    await egressExitPolicy(env, region, platformEgressDomains(url.origin, env.BLUE_AWS_REGION)),
  );
  const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
  const headers = { etag, "cache-control": "no-store" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, "content-type": "application/json" } });
}

/**
 * `GET /v1/egress-ips`: the fixed IPs per region, for customers to allowlist.
 * Public: the IPs are what customers are told anyway.
 */
export function egressIpsResponse(): Response {
  const regions: Record<string, { ipv4: string[] }> = {};
  for (const region of fixedIpsRegions()) {
    regions[region] = { ipv4: egressExitsFor(region).map((exit) => exit.egress_ipv4) };
  }
  return Response.json({ regions }, { headers: { "cache-control": "public, max-age=300" } });
}
