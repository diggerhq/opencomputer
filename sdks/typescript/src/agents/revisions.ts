import type { Http } from "./http.js";

// Agent Revisions (design 009) — the deploy lifecycle of an agent's behavior. A revision is an
// immutable, content-addressed payload {prompt, model, skills, …}; the active revision is the
// production pointer; rollback re-points it. Browser-safe REST (the directory→deploy bundler is
// Node-only — see `@opencomputer/sdk/node`'s `deployAgentDir`).

/** A skill file in a deploy payload. `mode` is an octal int (0o644 default | 0o755). */
export interface SkillFileInput { path: string; content: string; mode?: number; }

export interface DeployParams {
  /** The system prompt (required by the deploy API; the directory bundler fills it from prompt.md). */
  prompt?: string;
  /** `provider/model` id; omit for the runtime default. */
  model?: string;
  /** The skill file tree (skill-root-relative paths). Omit for no skills. v1: claude runtime only. */
  skills?: SkillFileInput[];
  /** Reserved — rejected in v1 (`not_supported_v1`). */
  mcp?: Record<string, unknown> | null;
  /** v1: only `{ type: "default" }`; `custom` is rejected (v2). */
  runtime?: { type: "default" | "custom" };
  /** Auto-activate (move the production pointer). Default true. */
  activate?: boolean;
  /** Provenance only (not part of the behavior digest). */
  source?: { via?: string; repoId?: string; path?: string; gitSha?: string };
}

export interface RevisionRef { id: string; number: number; digest: string; active: boolean; }
export interface DeployResult {
  deployId: string;
  state: "ready";
  result: "created" | "deduped";
  revision: RevisionRef;
}

export interface RevisionSummary { id: string; number: number; digest: string; createdAt: string; active: boolean; }
export interface SkillManifestEntry { path: string; mode: number; size: number; sha256: string; }
export interface Revision {
  id: string;
  number: number;
  digest: string;
  prompt: string;
  model: string | null;
  skillBundleDigest: string | null;
  runtimeRef: { mode: "floating" | "pinned"; buildId?: string };
  createdAt: string;
  files: SkillManifestEntry[];
}
export interface DeployEvent {
  id: string;
  state: string;
  result: string | null;
  source: Record<string, unknown> | null;
  actor: string | null;
  revisionId: string | null;
  createdAt: string;
}
export interface Activation { from: string | null; to: string; actor: string | null; reason: string; createdAt: string; }

/** Per-agent revision lifecycle. Reached via `oc.agents.revisions`; methods take the agent id. */
export class AgentRevisions {
  constructor(private readonly http: Http) {}

  /** Deploy = create (and, by default, activate) a revision. Idempotent by behavior digest. */
  create(agentId: string, params: DeployParams): Promise<DeployResult> {
    return this.http.request("POST", `/agents/${agentId}/revisions`, { body: params, idempotent: true });
  }
  /** Revision history (newest first). */
  list(agentId: string): Promise<{ data: RevisionSummary[] }> {
    return this.http.request("GET", `/agents/${agentId}/revisions`);
  }
  /** A single revision (by `rev_…` id or number) + its skill manifest. */
  get(agentId: string, ref: string | number): Promise<Revision> {
    return this.http.request("GET", `/agents/${agentId}/revisions/${ref}`);
  }
  /** Promote / roll back to a revision (by id or number) — moves the production pointer. */
  activate(agentId: string, ref: string | number): Promise<{ activeRevisionId: string }> {
    return this.http.request("POST", `/agents/${agentId}/revisions/${ref}/activate`, { body: {}, idempotent: true });
  }
  /** Deploy timeline (provenance + state). */
  deploys(agentId: string): Promise<{ data: DeployEvent[] }> {
    return this.http.request("GET", `/agents/${agentId}/deploys`);
  }
  /** Activation history (pointer audit). */
  activations(agentId: string): Promise<{ data: Activation[] }> {
    return this.http.request("GET", `/agents/${agentId}/activations`);
  }
}
