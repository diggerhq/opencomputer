// github_star.ts — "Star us on GitHub, get $5" during onboarding.
//
// Verification is deliberately loose (Mohamed, 2026-11-11): the bonus is for
// engagement and the trial is three days, so we do not tie a star to a GitHub
// identity. Clicking "Star on GitHub" records the repo's stargazer count; the
// claim succeeds once the count has gone up since. A fraudster can claim on
// someone else's star, and that is fine. One bonus per org, Autumn orgs only.

import { syncAutumnToD1, trackAutumnUsage, type AutumnSyncEnv } from "./autumn_webhook";

export const GITHUB_STAR_REPO = "diggerhq/opencomputer";
export const GITHUB_STAR_BONUS_USD = 5;

export interface GitHubStarEnv extends AutumnSyncEnv {
  OPENCOMPUTER_DB: D1Database;
  AUTUMN_SECRET_KEY: string;
  AUTUMN_BASE_URL?: string;
  // Optional: any token that can read public repos. Unauthenticated calls
  // share GitHub's 60/hour limit with everything else on Cloudflare's IP.
  GITHUB_TOKEN?: string;
}

interface StarRow {
  billing_provider: string;
  github_star_baseline: number | null;
  github_star_bonus_at: number | null;
}

export interface GitHubStarState {
  eligible: boolean;
  claimed: boolean;
  started: boolean;
  bonusUsd: number;
  repoUrl: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function readRow(env: GitHubStarEnv, orgID: string): Promise<StarRow | null> {
  return env.OPENCOMPUTER_DB.prepare(
    "SELECT billing_provider, github_star_baseline, github_star_bonus_at FROM orgs WHERE id = ?1",
  ).bind(orgID).first<StarRow>();
}

function stateOf(row: StarRow): GitHubStarState {
  return {
    eligible: row.billing_provider === "autumn" && row.github_star_bonus_at === null,
    claimed: row.github_star_bonus_at !== null,
    started: row.github_star_baseline !== null,
    bonusUsd: GITHUB_STAR_BONUS_USD,
    repoUrl: `https://github.com/${GITHUB_STAR_REPO}`,
  };
}

export async function stargazerCount(env: GitHubStarEnv): Promise<number> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "opencomputer-api-edge",
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_STAR_REPO}`, { headers });
  if (!resp.ok) throw new Error(`github repo ${resp.status}: ${await resp.text()}`);
  const body = (await resp.json()) as { stargazers_count?: unknown };
  if (typeof body.stargazers_count !== "number") throw new Error("github repo: no stargazers_count");
  return body.stargazers_count;
}

// GET /github-star
export async function handleGitHubStarState(env: GitHubStarEnv, orgID: string): Promise<Response> {
  const row = await readRow(env, orgID);
  if (!row) return json({ error: "org not found" }, 404);
  return json(stateOf(row));
}

// POST /github-star/start — the person is off to GitHub; remember the count.
export async function handleGitHubStarStart(env: GitHubStarEnv, orgID: string): Promise<Response> {
  const row = await readRow(env, orgID);
  if (!row) return json({ error: "org not found" }, 404);
  if (!stateOf(row).eligible) return json(stateOf(row));
  let count: number;
  try {
    count = await stargazerCount(env);
  } catch (err) {
    console.error(`github-star start ${orgID}`, err);
    return json({ error: "couldn't reach GitHub" }, 502);
  }
  await env.OPENCOMPUTER_DB.prepare(
    "UPDATE orgs SET github_star_baseline = ?1 WHERE id = ?2 AND github_star_bonus_at IS NULL",
  ).bind(count, orgID).run();
  return json(stateOf({ ...row, github_star_baseline: count }));
}

// POST /github-star/claim — grant the bonus once the count went up.
export async function handleGitHubStarClaim(env: GitHubStarEnv, orgID: string): Promise<Response> {
  const row = await readRow(env, orgID);
  if (!row) return json({ error: "org not found" }, 404);
  const state = stateOf(row);
  if (!state.eligible) return json(state);
  if (row.github_star_baseline === null) return json({ error: "star the repo first" }, 409);
  let count: number;
  try {
    count = await stargazerCount(env);
  } catch (err) {
    console.error(`github-star claim ${orgID}`, err);
    return json({ error: "couldn't reach GitHub" }, 502);
  }
  if (count <= row.github_star_baseline) return json({ error: "no new star yet" }, 409);

  // Mark first so two concurrent claims grant once; Autumn's idempotency key
  // backs that up across retries.
  const now = Math.floor(Date.now() / 1000);
  const marked = await env.OPENCOMPUTER_DB.prepare(
    "UPDATE orgs SET github_star_bonus_at = ?1 WHERE id = ?2 AND github_star_bonus_at IS NULL",
  ).bind(now, orgID).run();
  if (!marked.meta.changes) return json(stateOf({ ...row, github_star_bonus_at: now }));
  try {
    // A negative track adds to the balance.
    await trackAutumnUsage(env, {
      customerID: orgID,
      featureID: "credits",
      value: -GITHUB_STAR_BONUS_USD,
      idempotencyKey: `github-star-bonus-${orgID}`,
    });
  } catch (err) {
    console.error(`github-star grant ${orgID}`, err);
    await env.OPENCOMPUTER_DB.prepare("UPDATE orgs SET github_star_bonus_at = NULL WHERE id = ?1")
      .bind(orgID).run();
    return json({ error: "couldn't add the credits" }, 502);
  }
  try {
    await syncAutumnToD1(env, orgID);
  } catch (err) {
    console.error(`github-star sync ${orgID}`, err);
  }
  return json(stateOf({ ...row, github_star_bonus_at: now }));
}
