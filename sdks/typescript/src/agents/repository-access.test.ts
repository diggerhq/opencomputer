import { describe, expect, it, vi } from "vitest";
import type { RepositoryAccessPolicy } from "../index.js";
import { OpenComputer } from "./client.js";
import { ConflictError, NotFoundError } from "./errors.js";

// @ts-expect-error selected policy requires an explicit repository list
const selectedWithoutRepositories: RepositoryAccessPolicy = { mode: "selected" };
void selectedWithoutRepositories;

const allWithRepositories: RepositoryAccessPolicy = {
  mode: "all",
  // @ts-expect-error all policy cannot carry a selected repository list
  repositoryIds: ["repo_0123456789abcdef01234567"],
};
void allWithRepositories;

const wireAccess = {
  policy: {
    mode: "selected",
    repository_ids: ["repo_0123456789abcdef01234567"],
  },
  grant: {
    status: "active",
    account: "example",
    repository_selection: "selected",
    install_url: "https://github.com/apps/opencomputer/installations/new?state=opaque",
    configure_url: "https://github.com/settings/installations/123",
    truncated: false,
  },
  effective_repositories: [
    {
      id: "repo_0123456789abcdef01234567",
      full_name: "example/support-agent",
      default_branch: "main",
      private: true,
    },
  ],
  unavailable_selected_repositories: [
    {
      id: "repo_89abcdef0123456701234567",
      full_name: "example/retired-agent",
    },
  ],
};

function client(fetcher: typeof fetch): OpenComputer {
  return new OpenComputer({
    apiKey: "oc_test",
    baseUrl: "https://api.example.test/v3",
    fetch: fetcher,
    maxRetries: 0,
  });
}

describe("agent repository access", () => {
  it("reads and camel-cases policy, grant, and repository state", async () => {
    const fetcher = vi.fn(async () => Response.json(wireAccess));
    const oc = client(fetcher as typeof fetch);

    const access = await oc.agents.getRepositoryAccess("agt_1");

    expect(access).toEqual({
      policy: {
        mode: "selected",
        repositoryIds: ["repo_0123456789abcdef01234567"],
      },
      grant: {
        status: "active",
        account: "example",
        repositorySelection: "selected",
        installUrl: "https://github.com/apps/opencomputer/installations/new?state=opaque",
        configureUrl: "https://github.com/settings/installations/123",
        truncated: false,
      },
      effectiveRepositories: [
        {
          id: "repo_0123456789abcdef01234567",
          fullName: "example/support-agent",
          defaultBranch: "main",
          private: true,
        },
      ],
      unavailableSelectedRepositories: [
        {
          id: "repo_89abcdef0123456701234567",
          fullName: "example/retired-agent",
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v3/agents/agt_1/repository-access",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("preserves an unavailable grant's null effective view", async () => {
    const fetcher = vi.fn(async () => Response.json({
      ...wireAccess,
      grant: {
        ...wireAccess.grant,
        status: "unavailable",
        account: null,
        repository_selection: null,
        configure_url: null,
      },
      effective_repositories: null,
      unavailable_selected_repositories: [],
    }));
    const oc = client(fetcher as typeof fetch);

    const access = await oc.agents.getRepositoryAccess("agt_1");

    expect(access.grant.status).toBe("unavailable");
    expect(access.effectiveRepositories).toBeNull();
    expect(access.unavailableSelectedRepositories).toEqual([]);
  });

  it("replaces the policy with the exact snake-case wire body", async () => {
    const fetcher = vi.fn(async () => Response.json(wireAccess));
    const oc = client(fetcher as typeof fetch);

    const access = await oc.agents.updateRepositoryAccess("agt_1", {
      mode: "selected",
      repositoryIds: ["repo_0123456789abcdef01234567"],
    });

    expect(access.policy).toEqual({
      mode: "selected",
      repositoryIds: ["repo_0123456789abcdef01234567"],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v3/agents/agt_1/repository-access",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          mode: "selected",
          repository_ids: ["repo_0123456789abcdef01234567"],
        }),
      }),
    );
  });

  it("sends the all policy without a repository list", async () => {
    const fetcher = vi.fn(async () => Response.json({
      ...wireAccess,
      policy: { mode: "all" },
    }));
    const oc = client(fetcher as typeof fetch);

    const access = await oc.agents.updateRepositoryAccess("agt_1", {
      mode: "all",
    });

    expect(access.policy).toEqual({ mode: "all" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v3/agents/agt_1/repository-access",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ mode: "all" }),
      }),
    );
  });

  it.each([
    [404, "not_found", NotFoundError],
    [409, "repository_access_not_supported", ConflictError],
  ] as const)("maps a %s boundary error through the standard SDK error", async (
    status,
    type,
    ErrorClass,
  ) => {
    const fetcher = vi.fn(async () => Response.json(
      { error: { type, message: "repository access unavailable", request_id: "req_1" } },
      { status },
    ));
    const oc = client(fetcher as typeof fetch);

    const request = oc.agents.getRepositoryAccess("agt_1");

    await expect(request).rejects.toBeInstanceOf(ErrorClass);
    await expect(request).rejects.toMatchObject({
      status,
      type,
      requestId: "req_1",
    });
  });
});
