import { describe, expect, it, vi } from "vitest";
import { OpenComputer } from "./client.js";

const wireSource = {
  name: "target",
  status: "resolved",
  path: "/workspace/sources/target",
  repo_id: "repo_0123456789abcdef01234567",
  full_name: "example/support-agent",
  requested_ref: "main",
  sha: "a".repeat(40),
  resolved_sha: "a".repeat(40),
};

describe("managed session source summaries", () => {
  it("camel-cases repository identity on create and live source reads", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        session: { id: "ses_1", status: "queued" },
        sources: [wireSource],
      }))
      .mockResolvedValueOnce(Response.json([wireSource]));
    const oc = new OpenComputer({
      apiKey: "oc_test",
      baseUrl: "https://api.example.test/v3",
      fetch: fetcher as typeof fetch,
      maxRetries: 0,
    });

    const session = await oc.sessions.create({
      agent: "agt_1",
      input: "Inspect the target repository",
    });

    expect(session.sources[0]).toMatchObject({
      repoId: "repo_0123456789abcdef01234567",
      fullName: "example/support-agent",
      requestedRef: "main",
      resolvedSha: "a".repeat(40),
    });
    await expect(session.listSources()).resolves.toEqual([
      expect.objectContaining({
        repoId: "repo_0123456789abcdef01234567",
        fullName: "example/support-agent",
        requestedRef: "main",
      }),
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/v3/sessions/ses_1/sources",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
