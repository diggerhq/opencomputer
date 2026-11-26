import { generateKeyPairSync, verify as nodeVerify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  exchangeGitHubUserCode,
  getGitHubInstallation,
  getGitHubUserInstallation,
  listGitHubInstallationRepositories,
  listGitHubUserInstallations,
  waitForGitHubUserInstallation,
  gitHubAppJwt,
  importGitHubAppKey,
  mintGitHubInstallationToken,
  parseGitHubPermissions,
  parseGitHubRepositoryCursor,
} from "../src/edge/github.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub App credentials", () => {
  it("exchanges the one-time installation authorization code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ access_token: "temporary-user-token" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeGitHubUserCode({
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "one-time-code",
      }),
    ).resolves.toBe("temporary-user-token");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(String(init.body)).toBe(
      "client_id=client-id&client_secret=client-secret&code=one-time-code",
    );
  });

  it("validates and canonicalizes the supported permission subset", () => {
    expect(
      parseGitHubPermissions({ pull_requests: "write", contents: "read" }),
    ).toEqual({ contents: "read", pull_requests: "write" });
    expect(parseGitHubPermissions({})).toBeNull();
    expect(parseGitHubPermissions({ metadata: "write" })).toBeNull();
    expect(parseGitHubPermissions({ administration: "read" })).toBeNull();
  });

  it("imports GitHub's PKCS#1 key and signs an RS256 App JWT", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = await gitHubAppJwt(4242, await importGitHubAppKey(pem));
    const [header, payload, signature] = jwt.split(".");
    const claims = JSON.parse(
      Buffer.from(payload!, "base64url").toString(),
    ) as { iss: string; iat: number; exp: number };

    expect(claims.iss).toBe("4242");
    expect(claims.exp - claims.iat).toBe(600);
    expect(
      nodeVerify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("mints for the complete installation repository grant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        { token: "opaque-token", expires_at: "2026-09-11T20:00:00Z" },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mintGitHubInstallationToken({
        appJwt: "app-jwt",
        installationId: 123,
        permissions: { contents: "write", pull_requests: "write" },
      }),
    ).resolves.toEqual({
      token: "opaque-token",
      expiresAt: "2026-09-11T20:00:00Z",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      permissions: { contents: "write", pull_requests: "write" },
    });
    expect(String(init.body)).not.toMatch(/repositories|repository_ids/);
  });

  it("reads the repository selection owned by a GitHub installation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: 123,
        app_id: 4242,
        account: { id: 99, login: "octo-org", type: "Organization" },
        repository_selection: "selected",
        suspended_at: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGitHubInstallation("app-jwt", 123)).resolves.toEqual({
      installationId: 123,
      appId: 4242,
      accountId: 99,
      accountLogin: "octo-org",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/123",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer app-jwt" }),
      }),
    );
  });

  it("verifies installation ownership with the authorizing user token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: 123,
        app_id: 4242,
        account: { id: 99, login: "octo-org", type: "Organization" },
        repository_selection: "all",
        suspended_at: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getGitHubUserInstallation("temporary-user-token", 123),
    ).resolves.toMatchObject({
      installationId: 123,
      appId: 4242,
      accountLogin: "octo-org",
      repositorySelection: "all",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/installations/123",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer temporary-user-token",
        }),
      }),
    );
  });

  it("discovers existing installations from the App user authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        total_count: 1,
        installations: [
          {
            id: 321,
            app_id: 4242,
            account: { id: 99, login: "octo-org", type: "Organization" },
            repository_selection: "selected",
            suspended_at: null,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listGitHubUserInstallations("temporary-user-token"),
    ).resolves.toMatchObject([
      {
        installationId: 321,
        appId: 4242,
        accountLogin: "octo-org",
        repositorySelection: "selected",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/installations?per_page=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer temporary-user-token",
        }),
      }),
    );
  });

  it("waits for a new installation to become visible to its authorizing user", async () => {
    const installation = {
      id: 321,
      app_id: 4242,
      account: { id: 99, login: "octo-org", type: "Organization" },
      repository_selection: "selected",
      suspended_at: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ total_count: 0, installations: [] }),
      )
      .mockResolvedValueOnce(
        Response.json({ total_count: 1, installations: [installation] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForGitHubUserInstallation("temporary-user-token", 321, {
        attempts: 2,
        initialDelayMs: 0,
      }),
    ).resolves.toMatchObject({
      installationId: 321,
      accountLogin: "octo-org",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub installation repositories", () => {
  it("reads one page of the installation grant with the caller's token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        total_count: 2,
        repository_selection: "selected",
        repositories: [
          {
            id: 1,
            full_name: "octo-org/service",
            private: true,
            default_branch: "main",
            archived: false,
            permissions: { push: true },
          },
          {
            id: 2,
            full_name: "octo-org/docs",
            private: false,
            default_branch: "trunk",
            archived: true,
          },
          { full_name: "octo-org/malformed-without-id" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listGitHubInstallationRepositories({ token: "metadata-token", page: 1, perPage: 100 }),
    ).resolves.toEqual({
      repositories: [
        { id: 1, fullName: "octo-org/service", private: true, defaultBranch: "main", archived: false },
        { id: 2, fullName: "octo-org/docs", private: false, defaultBranch: "trunk", archived: true },
      ],
      nextCursor: null,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(
      "https://api.github.com/installation/repositories?per_page=100&page=1",
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer metadata-token");
  });

  it("adds description, language and last push only when asked for details", async () => {
    const repository = {
      id: 1,
      full_name: "octo-org/service",
      private: true,
      default_branch: "main",
      archived: false,
      description: "The service",
      language: "Go",
      pushed_at: "2026-10-12T09:00:00Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({ total_count: 1, repositories: [repository] }))));
    const plain = await listGitHubInstallationRepositories({ token: "t", page: 1, perPage: 100 });
    expect(plain.repositories[0]).toEqual({ id: 1, fullName: "octo-org/service", private: true, defaultBranch: "main", archived: false });
    const detailed = await listGitHubInstallationRepositories({ token: "t", page: 1, perPage: 100, details: true });
    expect(detailed.repositories[0]).toMatchObject({ description: "The service", language: "Go", pushedAt: "2026-10-12T09:00:00Z" });
  });

  it("pages past one hundred by GitHub's page number and caps the page size", async () => {
    const fetchMock = vi.fn().mockImplementation((url: URL) =>
      Promise.resolve(
        Response.json({
          total_count: 150,
          repositories: Array.from({ length: url.searchParams.get("page") === "1" ? 100 : 50 }, (_, index) => ({
            id: index + 1 + (url.searchParams.get("page") === "1" ? 0 : 100),
            full_name: `octo-org/repo-${String(index)}`,
            private: true,
            default_branch: "main",
            archived: false,
          })),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await listGitHubInstallationRepositories({ token: "t", page: 1, perPage: 500 });
    expect(first.repositories).toHaveLength(100);
    expect(first.nextCursor).toBe("2");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("per_page=100&page=1");

    const second = await listGitHubInstallationRepositories({
      token: "t",
      page: parseGitHubRepositoryCursor(first.nextCursor)!,
      perPage: 100,
    });
    expect(second.repositories).toHaveLength(50);
    expect(second.repositories[0]!.id).toBe(101);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a cursor the listing did not issue", () => {
    expect(parseGitHubRepositoryCursor(null)).toBe(1);
    expect(parseGitHubRepositoryCursor("")).toBe(1);
    expect(parseGitHubRepositoryCursor("7")).toBe(7);
    expect(parseGitHubRepositoryCursor("0")).toBeNull();
    expect(parseGitHubRepositoryCursor("-1")).toBeNull();
    expect(parseGitHubRepositoryCursor("page:2")).toBeNull();
    expect(parseGitHubRepositoryCursor("1234567")).toBeNull();
  });

  it("reports GitHub failures as unavailable, retryable only for server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 })),
    );
    await expect(
      listGitHubInstallationRepositories({ token: "t", page: 1, perPage: 100 }),
    ).rejects.toMatchObject({ code: "github_unavailable", retryable: true });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("revoked", { status: 401 })),
    );
    await expect(
      listGitHubInstallationRepositories({ token: "t", page: 1, perPage: 100 }),
    ).rejects.toMatchObject({ code: "github_unavailable", retryable: false });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));
    await expect(
      listGitHubInstallationRepositories({ token: "t", page: 1, perPage: 100 }),
    ).rejects.toMatchObject({ code: "github_unavailable", retryable: true });
  });
});
