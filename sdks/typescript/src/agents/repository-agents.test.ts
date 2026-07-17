import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenComputer } from "./client.js";
import type { RepositorySourceInterpretation } from "./repository-agents.js";

// @ts-expect-error invalid profile identity must be flue-app-v1@1 or null/null
const crossedInvalidProfile: RepositorySourceInterpretation = {
  disposition: "invalid",
  sourceProfile: "flue-app-v1",
  sourceProfileVersion: null,
  summary: "Invalid source",
  reasonCode: "manifest_invalid",
  issues: [],
};
void crossedInvalidProfile;

const reviewResponse = {
  repository: {
    id: "repo_0123456789abcdef01234567",
    full_name: "example/support-agent",
    default_branch: "main",
  },
  root: "agents/support",
  production_ref: "main",
  sha: "a".repeat(40),
  interpretation: {
    disposition: "exact",
    source_profile: "flue-app-v1",
    source_profile_version: 1,
    summary: "Flue agent detected",
    reason_code: "flue_detected",
    assumptions: [],
    agent: { runtime: "flue", model: "anthropic/claude-haiku-4-5" },
  },
  profile: {
    source_profile: "flue-app-v1",
    source_profile_version: 1,
    manifest: {
      schema_version: 1,
      entrypoint: "support-triage",
      model: "anthropic/claude-haiku-4-5",
      runtime: { family: "flue", type: "default" },
      vars: {},
    },
    package: {
      name: "support-agent",
      node_engine: ">=22.19 <23",
      flue_cli: "^1.0.0",
    },
    lockfile: { version: 3 },
    builder: { node: "22.19.0" },
    source: { files: 12, bytes: 4096 },
    variable_names: [],
    warnings: [],
  },
  review_fingerprint: `sha256:${"b".repeat(64)}` as const,
  candidate_roots: [],
  candidate_roots_truncated: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent repository review/import", () => {
  it("normalizes a source-profile review and replays its receipt on import", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(reviewResponse))
      .mockResolvedValueOnce(
        Response.json({
          agent: {
            id: "agt_imported",
            name: "Support triage",
            model: "anthropic/claude-haiku-4-5",
            runtime: "flue",
          },
          source: {
            agent_id: "agt_imported",
            repo_id: reviewResponse.repository.id,
            path: reviewResponse.root,
            production_ref: reviewResponse.production_ref,
            status: "active",
          },
          deployment: { id: "dep_first", state: "accepted" },
        }),
      );
    const oc = new OpenComputer({
      apiKey: "oc_test",
      baseUrl: "https://api.example.test/v3",
      maxRetries: 0,
    });

    const review = await oc.agents.repository.review({
      repo: reviewResponse.repository.id,
      path: reviewResponse.root,
      productionRef: reviewResponse.production_ref,
    });
    expect(review.interpretation.disposition).toBe("exact");
    expect(review.interpretation.sourceProfile).toBe("flue-app-v1");
    expect(review.profile?.manifest.entrypoint).toBe("support-triage");

    if (review.interpretation.disposition !== "exact") {
      throw new Error("fixture must be importable");
    }
    await oc.agents.repository.import({
      name: "Support triage",
      credential: "managed",
      idempotencyKey: "import-command-1",
      source: {
        type: "github",
        repo: review.repository.id,
        path: review.root,
        productionRef: review.productionRef,
      },
      review: {
        sha: review.sha,
        sourceProfile: review.interpretation.sourceProfile,
        fingerprint: review.reviewFingerprint,
      },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.test/v3/github/deploy-app/inspect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          repo: reviewResponse.repository.id,
          path: "agents/support",
          production_ref: "main",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/v3/agents/import",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": "import-command-1",
        }),
      }),
    );
    const importInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(importInit.body))).toEqual({
      name: "Support triage",
      credential: "managed",
      source: {
        type: "github",
        repo: reviewResponse.repository.id,
        path: "agents/support",
        production_ref: "main",
      },
      review: {
        sha: reviewResponse.sha,
        source_profile: "flue-app-v1",
        fingerprint: `sha256:${"b".repeat(64)}`,
      },
    });
  });
});
