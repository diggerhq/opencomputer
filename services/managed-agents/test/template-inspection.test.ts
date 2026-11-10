import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const base = "https://managedagents.test";
const fullName = "octo/widgets";
const repositoryUrl = `https://github.com/${fullName}`;
const commitSha = "a".repeat(40);

async function inspect(body: Record<string, unknown>, query = "") {
  return SELF.fetch(
    `${base}/v1/public/template-inspections${query}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

async function seed(state: string) {
  const now = new Date().toISOString();
  await env.SERVERLESS_AGENTS_DB.prepare(
    `INSERT INTO template_registrations
     (id, repository_url, repository_full_name, state, trigger_run_id, error, created_at, updated_at)
     VALUES ('tplreg_test', ?, ?, ?, NULL, NULL, ?, ?)`,
  )
    .bind(repositoryUrl, fullName, state, now, now)
    .run();
  await env.SERVERLESS_AGENTS_DB.prepare(
    `INSERT INTO template_versions
     (id, registration_id, repository_url, repository_full_name, commit_sha,
      build_generation, mirror_repo_id, template_json, agents_json,
      requirements_json, artifacts_json, resources_json, created_at)
     VALUES ('tplver_test', 'tplreg_test', ?, ?, ?, 2, 'repo_x',
             ?, ?, ?, '[]', '{}', ?)`,
  )
    .bind(
      repositoryUrl,
      fullName,
      commitSha,
      JSON.stringify({ name: "Widgets", description: "d" }),
      JSON.stringify([{ id: "worker", name: "Worker" }]),
      JSON.stringify({
        secrets: [],
        runtimeVariables: [],
        connections: [],
      }),
      now,
    )
    .run();
}

beforeEach(async () => {
  await env.SERVERLESS_AGENTS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS template_registrations (
      id TEXT PRIMARY KEY,
      repository_url TEXT NOT NULL,
      repository_full_name TEXT NOT NULL,
      state TEXT NOT NULL,
      trigger_run_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
  await env.SERVERLESS_AGENTS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS template_versions (
      id TEXT PRIMARY KEY,
      registration_id TEXT NOT NULL,
      repository_url TEXT NOT NULL,
      repository_full_name TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      build_generation INTEGER NOT NULL DEFAULT 1,
      mirror_repo_id TEXT NOT NULL,
      template_json TEXT NOT NULL,
      agents_json TEXT NOT NULL,
      requirements_json TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  ).run();
  await env.SERVERLESS_AGENTS_DB.prepare(
    "DELETE FROM template_versions",
  ).run();
  await env.SERVERLESS_AGENTS_DB.prepare(
    "DELETE FROM template_registrations",
  ).run();
});

afterEach(async () => {
  await env.SERVERLESS_AGENTS_DB.prepare(
    "DELETE FROM template_versions",
  ).run();
  await env.SERVERLESS_AGENTS_DB.prepare(
    "DELETE FROM template_registrations",
  ).run();
});

describe("template inspections", () => {
  it("serves the cached version while no build is in flight", async () => {
    await seed("ready");
    const response = await inspect({ repositoryUrl });
    expect(response.status).toBe(200);
    const body = await response.json<{ status?: string; repository?: { commitSha?: string } }>();
    expect(body.status).toBe("ready");
    expect(body.repository?.commitSha).toBe(commitSha);
  });

  it("returns preparing instead of the stale cached version while a rebuild is in flight", async () => {
    await seed("preparing");
    const response = await inspect({ repositoryUrl });
    expect(response.status).toBe(202);
    const body = await response.json<{ status?: string }>();
    expect(body.status).toBe("preparing");
  });

  it("forces a rebuild when the body asks for a refresh", async () => {
    await seed("ready");
    const response = await inspect({ repositoryUrl, refresh: true });
    // Trigger.dev is not configured in tests, so the rebuild attempt fails —
    // what matters is that it did not serve the cached version (200).
    expect(response.status).not.toBe(200);
    const registration = await env.SERVERLESS_AGENTS_DB.prepare(
      "SELECT state FROM template_registrations WHERE repository_full_name = ?",
    )
      .bind(fullName)
      .first<{ state: string }>();
    expect(registration?.state).not.toBe("ready");
  });
});
