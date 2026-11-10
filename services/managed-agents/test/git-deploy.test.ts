import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGitHubBranchHead,
  listGitHubRepositoryBranches,
  verifyGitHubWebhookSignature,
} from "../src/edge/github.js";
import {
  cachedRepositoryPage,
  gitDeploymentAlias,
  isPreviewAlias,
  normalizeSourcePath,
  previewAlias,
  purgeGitHubRepositoryCache,
  pushChangedPaths,
  rememberRepositoryPage,
  sourcePathUntouched,
  sweepStaleGitBuilds,
} from "../src/edge/git-deploy-service.js";

// ── A D1 stand-in over node:sqlite for the statements under test ────────────

function sqliteD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  return {
    prepare: (sql: string) => ({
      bind: (...bindings: unknown[]) => {
        const statement = db.prepare(sql);
        return {
          run: () => {
            statement.run(...(bindings as never[]));
          },
          all: <T>() => ({
            results: statement.all(...(bindings as never[])) as T[],
          }),
          first: <T>() =>
            (statement.get(...(bindings as never[])) as T) ?? null,
        };
      },
    }),
  } as unknown as D1Database;
}

afterEach(() => vi.unstubAllGlobals());

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GitHub webhook signatures", () => {
  it("accepts a matching X-Hub-Signature-256", async () => {
    const body = JSON.stringify({ action: "opened" });
    await expect(
      verifyGitHubWebhookSignature(
        "hook-secret",
        new TextEncoder().encode(body).buffer as ArrayBuffer,
        sign("hook-secret", body),
      ),
    ).resolves.toBe(true);
  });

  it("rejects a missing, malformed, or mismatched signature", async () => {
    const body = new TextEncoder().encode("{}").buffer as ArrayBuffer;
    await expect(
      verifyGitHubWebhookSignature("hook-secret", body, null),
    ).resolves.toBe(false);
    await expect(
      verifyGitHubWebhookSignature("hook-secret", body, "sha1=abc"),
    ).resolves.toBe(false);
    await expect(
      verifyGitHubWebhookSignature("hook-secret", body, sign("other", "{}")),
    ).resolves.toBe(false);
  });
});

describe("preview aliases", () => {
  it("derives pr-<number> aliases and only accepts that shape", () => {
    expect(previewAlias(12)).toBe("pr-12");
    expect(isPreviewAlias("pr-12")).toBe(true);
    expect(isPreviewAlias("pr-0")).toBe(false);
    expect(isPreviewAlias("development")).toBe(false);
    expect(isPreviewAlias("pr-12/x")).toBe(false);
  });
});

describe("Git deployment aliases", () => {
  it("publishes a single-mode main build to default without changing previews or legacy projects", () => {
    expect(gitDeploymentAlias({ environmentMode: "single" }, "development")).toBe("default");
    expect(gitDeploymentAlias({ environmentMode: "single" }, "pr-12")).toBe("pr-12");
    expect(gitDeploymentAlias({ environmentMode: "legacy" }, "development")).toBe("development");
  });
});

describe("source paths", () => {
  it("treats the repo root as no directory and trims wrapping separators", () => {
    expect(normalizeSourcePath(undefined)).toBeNull();
    expect(normalizeSourcePath(null)).toBeNull();
    expect(normalizeSourcePath("")).toBeNull();
    expect(normalizeSourcePath(".")).toBeNull();
    expect(normalizeSourcePath("agents/hello/")).toBe("agents/hello");
  });

  it("rejects paths that escape the checkout", () => {
    expect(normalizeSourcePath("../outside")).toBeUndefined();
    expect(normalizeSourcePath("a/../b")).toBeUndefined();
    expect(normalizeSourcePath("/etc")).toBeUndefined();
    expect(normalizeSourcePath("a//b")).toBeUndefined();
    expect(normalizeSourcePath("a\\b")).toBeUndefined();
    expect(normalizeSourcePath(42)).toBeUndefined();
  });
});

describe("GitHub branch reads", () => {
  it("lists branches with their tip commits", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([
        { name: "main", commit: { sha: "a".repeat(40) } },
        { name: "feature", commit: { sha: "b".repeat(40) } },
        { name: "broken" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listGitHubRepositoryBranches({ token: "tok", fullName: "acme/agent" }),
    ).resolves.toEqual([
      { name: "main", commitSha: "a".repeat(40) },
      { name: "feature", commitSha: "b".repeat(40) },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/acme/agent/branches?per_page=100&page=1",
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("reports a missing branch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 404 })),
    );
    await expect(
      getGitHubBranchHead({ token: "tok", fullName: "acme/agent", branch: "x" }),
    ).rejects.toMatchObject({ code: "installation_not_found" });
  });
});

describe("repository listing cache", () => {
  function cacheTable(): D1Database {
    const db = sqliteD1();
    db.prepare(
      `CREATE TABLE project_git_repo_cache (
         github_installation_id INTEGER NOT NULL,
         page INTEGER NOT NULL,
         body_json TEXT NOT NULL,
         fetched_at TEXT NOT NULL,
         PRIMARY KEY (github_installation_id, page)
       )`,
    )
      .bind()
      .run();
    return db;
  }
  const page1 = {
    repositories: [
      {
        id: 1,
        fullName: "acme/agent",
        private: false,
        defaultBranch: "main",
        archived: false,
      },
    ],
    nextCursor: null,
  };

  it("serves fresh pages, refreshes stale ones, and purges per installation", async () => {
    const db = cacheTable();
    const env = { SERVERLESS_AGENTS_DB: db };
    expect(await cachedRepositoryPage(env, 11, 1)).toBeNull();

    await rememberRepositoryPage(env, 11, 1, page1);
    await rememberRepositoryPage(env, 11, 2, { repositories: [], nextCursor: "2" });
    await rememberRepositoryPage(env, 22, 1, { repositories: [], nextCursor: null });

    const fresh = await cachedRepositoryPage(env, 11, 1);
    expect(fresh?.fresh).toBe(true);
    expect(fresh?.body).toEqual(page1);

    db.prepare(
      `UPDATE project_git_repo_cache SET fetched_at = datetime('now', '-1 day')
       WHERE github_installation_id = 11 AND page = 2`,
    )
      .bind()
      .run();
    expect((await cachedRepositoryPage(env, 11, 2))?.fresh).toBe(false);

    await purgeGitHubRepositoryCache(env, 11);
    expect(await cachedRepositoryPage(env, 11, 1)).toBeNull();
    expect(await cachedRepositoryPage(env, 11, 2)).toBeNull();
    expect((await cachedRepositoryPage(env, 22, 1))?.fresh).toBe(true);
  });
});

describe("source-path scoping", () => {
  it("collects every file a push touched across commits", () => {
    const paths = pushChangedPaths({
      commits: [
        { added: ["agents/hello/a.ts"], modified: ["README.md"], removed: [] },
        { modified: ["agents/hello/b.ts", "docs/x.md"] },
      ],
      head_commit: { added: ["root.ts"] },
    });
    expect(paths).toEqual(
      new Set([
        "agents/hello/a.ts",
        "agents/hello/b.ts",
        "README.md",
        "docs/x.md",
        "root.ts",
      ]),
    );
    expect(pushChangedPaths({ commits: "x", head_commit: null })).toEqual(
      new Set(),
    );
  });

  it("skips only when a configured directory is untouched", () => {
    const configured = { source_path: "agents/hello" };
    expect(
      sourcePathUntouched(configured, new Set(["README.md", "docs/x.md"])),
    ).toBe(true);
    expect(
      sourcePathUntouched(configured, new Set(["agents/hello/a.ts"])),
    ).toBe(false);
    // A sibling whose name shares the prefix must not count as touched.
    expect(
      sourcePathUntouched(configured, new Set(["agents/hello-world/a.ts"])),
    ).toBe(true);
    // Root (no directory) and unknown paths can never be scoped out.
    expect(
      sourcePathUntouched({ source_path: null }, new Set(["README.md"])),
    ).toBe(false);
    expect(sourcePathUntouched(configured, new Set())).toBe(false);
  });
});

describe("stale build sweep", () => {
  function buildsTable(): D1Database {
    const db = sqliteD1();
    db.prepare(
      `CREATE TABLE project_git_builds (
         id TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         state TEXT NOT NULL,
         error_message TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ).bind().run();
    const insert = db.prepare(
      `INSERT INTO project_git_builds
         (id, project_id, state, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now', ?), datetime('now', ?))`,
    );
    insert.bind("stale", "p1", "building", "-120 minutes", "-120 minutes").run();
    insert.bind("queued-stale", "p1", "queued", "-95 minutes", "-95 minutes").run();
    insert.bind("fresh", "p1", "building", "-5 minutes", "-5 minutes").run();
    insert.bind("done", "p1", "ready", "-300 minutes", "-300 minutes").run();
    insert.bind("other", "p2", "building", "-120 minutes", "-120 minutes").run();
    return db;
  }

  it("fails builds the runner outlived, and only those", async () => {
    const db = buildsTable();
    await sweepStaleGitBuilds(
      { SERVERLESS_AGENTS_DB: db },
      "p1",
    );
    const { results: rows } = await db
      .prepare("SELECT id, state, error_message FROM project_git_builds")
      .bind()
      .all<{ id: string; state: string; error_message: string | null }>();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("stale")?.state).toBe("failed");
    expect(byId.get("stale")?.error_message).toBe(
      "Build timed out waiting for the runner.",
    );
    expect(byId.get("queued-stale")?.state).toBe("failed");
    expect(byId.get("fresh")?.state).toBe("building");
    expect(byId.get("done")?.state).toBe("ready");
    expect(byId.get("other")?.state).toBe("building");
  });
});
