import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGitHubStarClaim, handleGitHubStarStart, type GitHubStarEnv } from "./github_star";

const orgID = "org-1";

function setup(opts: { provider?: string; stars: number[]; autumnFails?: boolean }) {
  const row = {
    billing_provider: opts.provider ?? "autumn",
    github_star_baseline: null as number | null,
    github_star_bonus_at: null as number | null,
  };
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() { return { ...row }; },
        async run() {
          let changes = 0;
          if (sql.includes("SET github_star_baseline")) {
            if (row.github_star_bonus_at === null) { row.github_star_baseline = args[0] as number; changes = 1; }
          } else if (sql.includes("SET github_star_bonus_at = NULL")) {
            row.github_star_bonus_at = null; changes = 1;
          } else if (sql.includes("SET github_star_bonus_at")) {
            if (row.github_star_bonus_at === null) { row.github_star_bonus_at = args[0] as number; changes = 1; }
          }
          return { meta: { changes } };
        },
      };
      return stmt;
    },
  };
  const tracks: unknown[] = [];
  const stars = [...opts.stars];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ stargazers_count: stars.shift() }));
    }
    if (url.endsWith("/track")) {
      tracks.push(JSON.parse(String(init?.body)));
      if (opts.autumnFails) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ balance: { remaining: 15 } }));
    }
    return new Response("not found", { status: 404 });
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const env = { OPENCOMPUTER_DB: db, AUTUMN_SECRET_KEY: "k" } as unknown as GitHubStarEnv;
  return { env, row, tracks };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("github star bonus", () => {
  it("grants $5 once the star count goes up, and only once", async () => {
    const { env, row, tracks } = setup({ stars: [100, 101, 102] });
    expect((await handleGitHubStarStart(env, orgID)).status).toBe(200);
    expect(row.github_star_baseline).toBe(100);

    const res = await handleGitHubStarClaim(env, orgID);
    expect(await res.json()).toMatchObject({ claimed: true, eligible: false });
    expect(tracks).toEqual([
      expect.objectContaining({ customer_id: orgID, feature_id: "credits", value: -5, idempotency_key: `github-star-bonus-${orgID}` }),
    ]);

    await handleGitHubStarClaim(env, orgID);
    expect(tracks).toHaveLength(1);
  });

  it("refuses while the count has not moved", async () => {
    const { env, tracks } = setup({ stars: [100, 100] });
    await handleGitHubStarStart(env, orgID);
    expect((await handleGitHubStarClaim(env, orgID)).status).toBe(409);
    expect(tracks).toHaveLength(0);
  });

  it("refuses a claim without a start", async () => {
    const { env } = setup({ stars: [100] });
    expect((await handleGitHubStarClaim(env, orgID)).status).toBe(409);
  });

  it("is not offered to orgs off Autumn", async () => {
    const { env, row } = setup({ provider: "legacy", stars: [100] });
    const res = await handleGitHubStarStart(env, orgID);
    expect(await res.json()).toMatchObject({ eligible: false });
    expect(row.github_star_baseline).toBeNull();
  });

  it("leaves the bonus claimable when Autumn fails", async () => {
    const { env, row } = setup({ stars: [100, 101], autumnFails: true });
    await handleGitHubStarStart(env, orgID);
    expect((await handleGitHubStarClaim(env, orgID)).status).toBe(502);
    expect(row.github_star_bonus_at).toBeNull();
  });
});
