// Two-phase repository agent creation. Review is read-only and pins the exact
// source interpretation the user confirmed; import revalidates that review
// before creating an agent or deployment.

import type { Http } from "./http.js";
import type { Agent, CredentialRef } from "./types.js";
import type { Deployment, DeploymentSource } from "./deployments.js";

export type SourceProfileId = "flue-app-v1";

export interface RepositoryAgentSource {
  type: "github";
  /** An owner-scoped `repo_…` id. */
  repo: string;
  /** Repository-relative root; use an empty string for the repository root. */
  path: string;
  /** The production branch OpenComputer resolves and follows for push-to-deploy. */
  productionRef: string;
}

export interface ReviewRepositoryAgentParams {
  repo: string;
  path: string;
  productionRef: string;
}

export interface RepositoryReviewIssue {
  code: string;
  message: string;
  path?: string;
}

export interface RepositoryCandidateRoot {
  path: string;
  sourceProfile: SourceProfileId | null;
  summary: string;
  marker:
    | "agent.toml"
    | "flue.config.ts"
    | "flue.config.js"
    | "flue.config.mjs"
    | "flue.config.cjs";
}

export interface FlueSourceProfile {
  sourceProfile: "flue-app-v1";
  sourceProfileVersion: 1;
  manifest: {
    schemaVersion: 1;
    entrypoint: string;
    model: string;
    runtime: { family: "flue"; type: string };
    /** Non-secret manifest variables. */
    vars: Record<string, string>;
  };
  package: {
    name: string | null;
    nodeEngine: string;
    flueCli: string;
  };
  lockfile: { version: number };
  builder: { node: string };
  source: { files: number; bytes: number };
  variableNames: string[];
  warnings: RepositoryReviewIssue[];
}

export type RepositorySourceInterpretation =
  | {
      disposition: "exact";
      sourceProfile: "flue-app-v1";
      sourceProfileVersion: 1;
      summary: string;
      reasonCode: "flue_detected";
      assumptions: string[];
      agent: { runtime: "flue"; model: string };
    }
  | {
      disposition: "invalid";
      sourceProfile: SourceProfileId | null;
      sourceProfileVersion: 1 | null;
      summary: string;
      reasonCode: string;
      issues: RepositoryReviewIssue[];
    }
  | {
      disposition: "unrecognized";
      sourceProfile: null;
      sourceProfileVersion: null;
      summary: string;
      reasonCode: "unrecognized_source";
    };

interface RepositoryAgentReviewBase {
  repository: {
    id: string;
    fullName: string;
    defaultBranch: string | null;
  };
  root: string;
  productionRef: string;
  sha: string;
  reviewFingerprint: string;
  candidateRoots: RepositoryCandidateRoot[];
  candidateRootsTruncated: boolean;
}

export type RepositoryAgentReview =
  | (RepositoryAgentReviewBase & {
      interpretation: Extract<
        RepositorySourceInterpretation,
        { disposition: "exact" }
      >;
      profile: FlueSourceProfile;
    })
  | (RepositoryAgentReviewBase & {
      interpretation: Extract<
        RepositorySourceInterpretation,
        { disposition: "invalid" }
      >;
      profile: null;
    })
  | (RepositoryAgentReviewBase & {
      interpretation: Extract<
        RepositorySourceInterpretation,
        { disposition: "unrecognized" }
      >;
      profile: null;
    });

export interface RepositoryReviewReceipt {
  sha: string;
  sourceProfile: SourceProfileId;
  fingerprint: string;
}

export interface ImportRepositoryAgentParams {
  name: string;
  source: RepositoryAgentSource;
  review: RepositoryReviewReceipt;
  /** Repository imports currently use Managed model access. */
  credential: Extract<CredentialRef, "managed">;
  /** Stable for one logical import; conflicting reuse fails safely. */
  idempotencyKey: string;
}

export interface ImportRepositoryAgentResult {
  agent: Agent;
  source: DeploymentSource;
  deployment: Deployment;
}

/** Review and import an agent from a repository (`oc.agents.repository`). */
export class AgentRepository {
  constructor(private readonly http: Http) {}

  /**
   * Resolve one exact commit and interpret its selected root without executing
   * repository code. Only an `exact` result can be imported.
   */
  review(params: ReviewRepositoryAgentParams): Promise<RepositoryAgentReview> {
    return this.http.request("POST", "/github/deploy-app/inspect", {
      body: params,
    });
  }

  /**
   * Revalidate a reviewed source plan, then atomically create its agent, source
   * link, and first deployment. The idempotency key is sent as a header.
   */
  import(
    params: ImportRepositoryAgentParams,
  ): Promise<ImportRepositoryAgentResult> {
    const { idempotencyKey, ...body } = params;
    return this.http.request("POST", "/agents/import", {
      body,
      idempotencyKey,
      idempotent: true,
    });
  }
}
