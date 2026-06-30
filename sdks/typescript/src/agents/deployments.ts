// Deploy / revision / skills / deployment-source sub-resources of `oc.agents` (deploy-from-github).
// You DEPLOY an agent's behavior (inline or from a linked repo); each deployment produces an
// immutable REVISION, and the ACTIVE revision is what new sessions run. The HTTP layer converts
// camelCase ⟷ snake_case on the wire, so params/results here are camelCase.

import type { Http } from "./http.js";
import type { Page } from "./agents.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InlineSkillFile { path: string; content: string; mode?: number | string; }

/** Behavior sent directly (the complete behavior — omitted `skills` means none). */
export interface InlineDeployInput {
  type: "inline";
  prompt?: string;
  model?: string;
  skills?: InlineSkillFile[];
  runtime?: { type?: "default" | "custom" };
}

/** Deploy the agent's linked repo at a ref/sha (repo/path come from the deployment source). */
export interface GithubDeployInput { type: "github"; ref?: string; sha?: string; }

export type DeployInput = InlineDeployInput | GithubDeployInput;

export interface CreateDeploymentParams {
  input: DeployInput;
  /** Honored for inline only; github deploys are branch-driven (ignored). Default true. */
  activate?: boolean;
  /** CI-safe: a re-run with the same key returns the existing deployment. */
  idempotencyKey?: string;
  /** Free-form caller note (not provenance). */
  clientContext?: Record<string, unknown>;
}

export interface Deployment {
  id: string;
  state: string;       // accepted|queued|fetching|validating|uploading|ready|failed|superseded|skipped
  result?: string | null;
  revisionId?: string | null;
  active?: boolean;
  inputType?: string;
  ref?: string | null;
  sha?: string | null;
  error?: unknown;
  errorClass?: string | null;
  createdAt?: string;
}

export interface RevisionFile { path: string; mode: number; size: number; }

export interface Revision {
  id: string;
  number: number;
  digest: string;
  prompt?: string;
  model?: string | null;
  skillBundleDigest?: string | null;
  runtimeRef?: unknown;
  active?: boolean;
  createdAt?: string;
  files?: RevisionFile[];
}

export interface Activation {
  id: string;
  from?: string | null;
  to: string;
  actor?: string | null;
  reason: string;
  createdAt?: string;
}

export interface SkillSummary {
  name: string;
  description: string | null;
  files: { path: string; mode: number; size: number }[];
}

export interface AgentSkills {
  revision: { id: string; number: number; digest: string } | null;
  skillBundleDigest: string | null;
  skills: SkillSummary[];
}

export interface DeploymentSource {
  agentId: string;
  ownerId?: string;
  repoId: string;
  path: string;
  productionRef: string;
  status: string; // active|path_missing|ref_missing|auth_required|repo_not_selected|app_suspended|error
  latestSeenSha?: string | null;
  activeDeployedSha?: string | null;
}

export interface LinkParams {
  /** "owner/repo" slug or a `repo_…` id. */
  repo: string;
  /** Agent dir within the repo ("" for the repo root). */
  path: string;
  /** Branch that auto-activates on push (default "main"). */
  productionRef?: string;
  /** Deploy the production HEAD immediately on link (default true). */
  deployNow?: boolean;
}

export interface LinkResult { source: DeploymentSource; deploymentId?: string; deployError?: { type: string; message: string }; }

/** Skill .zip body — a Blob (browser) or bytes (Node). */
export type SkillZip = Blob | ArrayBuffer | Uint8Array;

// ── Sub-resources ────────────────────────────────────────────────────────────

/** Deploy an agent's behavior; read the deployment history. */
export class Deployments {
  constructor(private readonly http: Http) {}

  /** Deploy (`input.type: "inline" | "github"`). Returns the deployment (inline is usually `ready`). */
  create(agentId: string, params: CreateDeploymentParams): Promise<{ deployment: Deployment }> {
    return this.http.request("POST", `/agents/${agentId}/deployments`, {
      body: { input: params.input, activate: params.activate, clientContext: params.clientContext },
      idempotencyKey: params.idempotencyKey,
      idempotent: params.idempotencyKey !== undefined,
    });
  }
  list(agentId: string): Promise<Page<Deployment>> {
    return this.http.request("GET", `/agents/${agentId}/deployments`);
  }
  get(agentId: string, deploymentId: string): Promise<Deployment> {
    return this.http.request("GET", `/agents/${agentId}/deployments/${deploymentId}`);
  }
}

/** Immutable, numbered revisions + the active pointer (rollback / promote). */
export class Revisions {
  constructor(private readonly http: Http) {}

  list(agentId: string): Promise<Page<Revision>> {
    return this.http.request("GET", `/agents/${agentId}/revisions`);
  }
  /** A revision by number or `rev_…` id (includes its skill file manifest). */
  get(agentId: string, rev: number | string): Promise<Revision> {
    return this.http.request("GET", `/agents/${agentId}/revisions/${rev}`);
  }
  /** Set the active revision — rollback (an earlier one) or promote (a staged one). */
  activate(agentId: string, rev: number | string): Promise<{ activeRevisionId: string }> {
    return this.http.request("POST", `/agents/${agentId}/revisions/${rev}/activate`, { idempotent: true });
  }
}

/** Active-pointer audit log. */
export class Activations {
  constructor(private readonly http: Http) {}
  list(agentId: string): Promise<Page<Activation>> {
    return this.http.request("GET", `/agents/${agentId}/activations`);
  }
}

/** The active revision's skills; replace/remove them (each is a deployment → a new revision). */
export class Skills {
  constructor(private readonly http: Http) {}

  get(agentId: string): Promise<AgentSkills> {
    return this.http.request("GET", `/agents/${agentId}/skills`);
  }
  /** Replace skills from a `.zip` (one folder per skill, each with a SKILL.md). */
  put(agentId: string, zip: SkillZip): Promise<unknown> {
    return this.http.upload("PUT", `/agents/${agentId}/skills`, zip as unknown as BodyInit, "application/zip");
  }
  /** Remove all skills (deploys a revision with none). */
  delete(agentId: string): Promise<unknown> {
    return this.http.request("DELETE", `/agents/${agentId}/skills`);
  }
}

/** Bind the agent to a repo directory for push-to-deploy (always the OpenComputer App). */
export class DeploymentSourceResource {
  constructor(private readonly http: Http) {}

  link(agentId: string, params: LinkParams): Promise<LinkResult> {
    return this.http.request("POST", `/agents/${agentId}/deployment-source`, { body: params });
  }
  get(agentId: string): Promise<{ source: DeploymentSource }> {
    return this.http.request("GET", `/agents/${agentId}/deployment-source`);
  }
  unlink(agentId: string): Promise<{ ok: boolean }> {
    return this.http.request("DELETE", `/agents/${agentId}/deployment-source`);
  }
}
