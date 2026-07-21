import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { ocRepoTools } from "./repo.js";
import type { OcRepoEnv } from "./repo.js";

type RunnableTool = {
  name: string;
  description: string;
  input: v.GenericSchema<Record<string, unknown>, unknown>;
  run(context: {
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown>;
};

function tools(
  env: OcRepoEnv = {
    OC_REPO_API: "https://sessions.opencomputer.test/",
    OC_SESSION_TOKEN: "deploy-token",
  },
  id = "ses_1",
): RunnableTool[] {
  return ocRepoTools({ id, env }) as RunnableTool[];
}

function tool(
  name: string,
  env?: OcRepoEnv,
  id?: string,
): RunnableTool {
  const found = tools(env, id).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("ocRepoTools contract", () => {
  it("returns exactly the three stable tools in workflow order", () => {
    expect(tools().map(({ name }) => name)).toEqual([
      "list_working_repos",
      "add_source",
      "github_publish_pull_request",
    ]);
  });

  it("keeps exact-target and safe-publish guidance in model context", () => {
    const [list, add, publish] = tools();
    expect(list?.description).toMatch(/exact owner\/repository/);
    expect(list?.description).toMatch(/Never assume the deployment source/);
    expect(list?.description).toMatch(/otherwise ask/);
    expect(add?.description).toMatch(/await this tool before filesystem work/);
    expect(add?.description).toMatch(/returned \/workspace\/sources/);
    expect(add?.description).toMatch(
      /reuse an existing source or start a new session/,
    );
    expect(publish?.description).toMatch(/inspect and test the diff/);
    expect(publish?.description).toMatch(
      /exact repository, base branch, and intended diff/,
    );
    expect(publish?.description).toMatch(/pull-request URL/);
  });

  it("uses strict bounded input schemas", () => {
    const list = tool("list_working_repos");
    expect(v.safeParse(list.input, { q: "owner/repo" }).success).toBe(true);
    expect(v.safeParse(list.input, { q: "x".repeat(101) }).success).toBe(
      false,
    );
    expect(v.safeParse(list.input, { surprise: true }).success).toBe(false);

    const add = tool("add_source");
    expect(
      v.safeParse(add.input, {
        repository: "repo_0123456789abcdef01234567",
        ref: "main",
        name: "app",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(add.input, { repository: "", ref: "main" }).success,
    ).toBe(false);
    expect(
      v.safeParse(add.input, {
        repository: "owner/repo",
        ref: "x".repeat(256),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(add.input, {
        repository: "owner/repo",
        ref: " \t ",
      }).success,
    ).toBe(false);

    const publish = tool("github_publish_pull_request");
    expect(
      v.safeParse(publish.input, {
        source: "app",
        title: "Document setup",
        base: "main",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(publish.input, {
        source: "app",
        title: "Document setup",
        base: "main",
        idempotency_key: "model-controlled",
      }).success,
    ).toBe(false);
    for (const invalid of [
      { source: "Bad Source", title: "Document setup", base: "main" },
      { source: "app", title: " ", base: "main" },
      { source: "app", title: "x".repeat(257), base: "main" },
      {
        source: "app",
        title: "Document setup",
        body: "x".repeat(65_537),
        base: "main",
      },
      { source: "app", title: "Document setup", base: "../main" },
      { source: "app", title: "Document setup", base: "bad ref" },
    ]) {
      expect(v.safeParse(publish.input, invalid).success).toBe(false);
    }
  });
});

describe("list_working_repos HTTP fixtures", () => {
  it("reads the captured env lazily at tool run and encodes the request", async () => {
    const env: OcRepoEnv = {};
    const list = tool("list_working_repos", env, "ses_/customer space");
    const fetchSpy = vi.fn(async () =>
      json({
        ok: true,
        repositories: [
          {
            id: "repo_1",
            full_name: "diggerhq/example app",
            default_branch: "main",
            visibility: "private",
          },
        ],
        truncated: true,
        server_revision: 2,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    env.OC_REPO_API = "https://sessions.opencomputer.test///";
    env.OC_SESSION_TOKEN = "request-token";
    const result = await list.run({ input: { q: "diggerhq/example app" } });

    expect(result).toEqual({
      ok: true,
      repositories: [
        {
          id: "repo_1",
          full_name: "diggerhq/example app",
          default_branch: "main",
        },
      ],
      truncated: true,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://sessions.opencomputer.test/flue/sessions/ses_%2Fcustomer%20space/repositories?q=diggerhq%2Fexample+app",
    );
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer request-token",
      },
    });
  });

  it.each([
    ["github_not_connected", 409, false],
    ["github_unavailable", 503, true],
    ["github_permission_missing", 409, false],
    ["repository_scope_empty", 403, false],
    ["repository_not_allowed", 403, false],
    ["repository_not_granted", 403, false],
    ["repository_not_found", 404, false],
    ["repository_rate_limited", 429, true],
    ["source_name_taken", 409, false],
    ["source_limit_reached", 409, false],
    ["source_unresolved", 422, true],
    ["source_materialization_failed", 503, true],
    ["source_not_ready", 409, true],
    ["publish_in_progress", 409, true],
    ["publish_failed", 502, false],
    ["stale_deployment_token", 409, false],
    ["deployment_updating", 503, true],
    ["deployment_unverified", 409, false],
  ] as const)(
    "returns the canonical %s product failure as tool data",
    async (code, status, retryable) => {
      const body = {
        ok: false as const,
        error: {
          code,
          message: `Safe recovery for ${code}`,
          retryable,
          ...(code === "repository_rate_limited"
            ? { retry_after_seconds: 17 }
            : {}),
        },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json(
            {
              ...body,
              server_trace_id: "trace_1",
              error: { ...body.error, provider_detail: "ignored" },
            },
            status,
          ),
        ),
      );

      await expect(
        tool("list_working_repos").run({ input: {} }),
      ).resolves.toEqual(body);
    },
  );

  it("accepts additive response growth without freezing list or message size", async () => {
    const repositories = Array.from({ length: 51 }, (_, index) => ({
      id: `repo_${index}`,
      full_name: `owner/repository-${index}`,
      default_branch: "main",
      future_field: index,
    }));
    const list = tool("list_working_repos");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({
            ok: true,
            repositories,
            truncated: false,
            next_cursor: null,
          }),
        )
        .mockResolvedValueOnce(
          json(
            {
              ok: false,
              error: {
                code: "github_unavailable",
                message: "x".repeat(501),
                retryable: true,
                future_recovery: "retry",
              },
            },
            503,
          ),
        ),
    );

    await expect(list.run({ input: {} })).resolves.toEqual({
      ok: true,
      repositories: repositories.map(({ id, full_name, default_branch }) => ({
        id,
        full_name,
        default_branch,
      })),
      truncated: false,
    });
    await expect(list.run({ input: {} })).resolves.toEqual({
      ok: false,
      error: {
        code: "github_unavailable",
        message: "x".repeat(501),
        retryable: true,
      },
    });
  });

  it("rejects status, retryability, and retry-after contract drift", async () => {
    const list = tool("list_working_repos");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            ok: false,
            error: {
              code: "repository_not_allowed",
              message: "Choose another repository.",
              retryable: false,
            },
          },
          500,
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            ok: false,
            error: {
              code: "github_unavailable",
              message: "Retry later.",
              retryable: false,
            },
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            ok: false,
            error: {
              code: "repository_rate_limited",
              message: "Wait before retrying.",
              retryable: true,
            },
          },
          429,
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    for (let i = 0; i < 3; i++) {
      await expect(list.run({ input: {} })).rejects.toThrow(
        "repository API returned an invalid response",
      );
    }
  });

  it("throws secret-safe errors for malformed platform responses", async () => {
    const leaked = "ghs_should-never-appear";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`provider said ${leaked}`, { status: 502 })),
    );

    let thrown: unknown;
    try {
      await tool("list_working_repos").run({ input: {} });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "[oc-flue] repository API returned an invalid response (status 502).",
    );
    expect((thrown as Error).message).not.toContain(leaked);
    expect((thrown as Error).message).not.toContain("deploy-token");
    expect((thrown as Error).message).not.toContain(
      "sessions.opencomputer.test",
    );
  });

  it("preserves cancellation while reading a response body", async () => {
    const aborted = new DOMException("cancelled while reading", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          status: 200,
          json: async () => {
            throw aborted;
          },
        } as Response;
      }),
    );

    await expect(
      tool("list_working_repos").run({ input: {} }),
    ).rejects.toBe(aborted);
  });
});

describe("add_source HTTP fixture", () => {
  it("posts the exact target and returns a usable pinned source path", async () => {
    const fetchSpy = vi.fn(async () =>
      json({
        ok: true,
        name: "app",
        repository_id: "repo_1",
        full_name: "diggerhq/example-app",
        ref: "main",
        sha: "a".repeat(40),
        path: "/workspace/sources/app",
        materialized_at: "2026-07-21T00:00:00Z",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await tool("add_source").run({
      input: {
        repository: "repo_0123456789abcdef01234567",
        ref: "main",
        name: "app",
      },
    });

    expect(result).toEqual({
      ok: true,
      name: "app",
      repository_id: "repo_1",
      full_name: "diggerhq/example-app",
      ref: "main",
      sha: "a".repeat(40),
      path: "/workspace/sources/app",
    });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://sessions.opencomputer.test/flue/sessions/ses_1/sources",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: "Bearer deploy-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repository: "repo_0123456789abcdef01234567",
        ref: "main",
        name: "app",
      }),
    });
  });

  it("rejects a success response whose path is outside the managed source root", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ok: true,
          name: "app",
          repository_id: "repo_1",
          full_name: "diggerhq/example-app",
          ref: "main",
          sha: "a".repeat(40),
          path: "/tmp/app",
        }),
      ),
    );

    await expect(
      tool("add_source").run({
        input: {
          repository: "repo_0123456789abcdef01234567",
          ref: "main",
          name: "app",
        },
      }),
    ).rejects.toThrow("repository API returned an invalid response");
  });
});

describe("github_publish_pull_request HTTP fixtures", () => {
  it("reuses one random idempotency key across an ambiguous transport retry", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        signals.push(init?.signal);
        calls++;
        if (calls === 1) throw new TypeError("network reset at secret host");
        return json({
          ok: true,
          no_changes: false,
          branch: "oc/ses_1/document-setup",
          commit: "d".repeat(40),
          pull_request: {
            number: 42,
            url: "https://github.com/diggerhq/example-app/pull/42",
            state: "open",
          },
          provider_request_id: "request_1",
        });
      }),
    );
    const controller = new AbortController();

    const result = await tool("github_publish_pull_request").run({
      input: {
        source: "app",
        title: "Document setup",
        body: "Adds setup notes.",
        base: "main",
        draft: true,
      },
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: true,
      no_changes: false,
      branch: "oc/ses_1/document-setup",
      commit: "d".repeat(40),
      pull_request: {
        number: 42,
        url: "https://github.com/diggerhq/example-app/pull/42",
      },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({
      source: "app",
      title: "Document setup",
      body: "Adds setup notes.",
      base: "main",
      draft: true,
    });
    expect(bodies[0]?.idempotency_key).toEqual(expect.any(String));
    expect(String(bodies[0]?.idempotency_key).length).toBeGreaterThanOrEqual(
      32,
    );
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it("returns no_changes as a successful terminal result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ok: true,
          no_changes: true,
          compared_commit: "a".repeat(40),
        }),
      ),
    );
    await expect(
      tool("github_publish_pull_request").run({
        input: {
          source: "app",
          title: "Document setup",
          base: "main",
        },
      }),
    ).resolves.toEqual({ ok: true, no_changes: true });
  });

  it("propagates AbortSignal cancellation without retrying or wrapping it", async () => {
    const aborted = new DOMException("cancelled", "AbortError");
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw aborted;
    });
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool("github_publish_pull_request").run({
        input: {
          source: "app",
          title: "Document setup",
          base: "main",
        },
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("sanitizes exhausted transport errors", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError(
        "request to https://secret.internal/?token=deploy-token failed",
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      tool("github_publish_pull_request").run({
        input: {
          source: "app",
          title: "Document setup",
          base: "main",
        },
      }),
    ).rejects.toThrow(
      "[oc-flue] repository API request failed before a response was received.",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("managed binding failures", () => {
  it("fails before fetch without printing missing or present binding values", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      tool("list_working_repos", {
        OC_SESSION_TOKEN: "secret-token",
      }).run({ input: {} }),
    ).rejects.toThrow(
      "[oc-flue] ocRepoTools requires managed repository API bindings.",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
