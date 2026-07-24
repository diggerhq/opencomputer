import type { Http, Query } from "./http.js";
import type { Agent, CredentialRef, Limits, Runtime } from "./types.js";
import {
  Deployments, Revisions, Activations, Skills, DeploymentSourceResource,
  type Deployment, type InlineSkillFile,
} from "./deployments.js";
import { Schedules } from "./schedules.js";
import { AgentRepository } from "./repository-agents.js";
import { AgentHooks } from "./hooks.js";

export interface CreateAgentParams {
  name: string;
  prompt: string;
  /** `provider/model` id; the provider must be one the runtime can drive (`anthropic/…` for `claude`, `openai/…` for `codex`, any catalog provider for `pi`). */
  model: string;
  /** Defaults to `claude`. Determines which providers the model may use (see `model`); immutable after create. */
  runtime?: Runtime;
  /** Model provider key, stored as a sealed credential — Anthropic for `claude`, OpenAI for `codex`, the model's provider for `pi`. Mutually exclusive with `credential`. */
  key?: string;
  /** Model source: `"managed"` (run via OpenComputer, no provider key) or a `cred_…` id. Omit for the org default. Mutually exclusive with `key`. */
  credential?: CredentialRef;
  limits?: Limits;
}

export interface UpdateAgentParams {
  prompt?: string;
  /** Stay within what the agent's runtime can drive (`anthropic/…` for `claude`, `openai/…` for `codex`, any catalog provider for `pi`); the runtime itself is immutable. */
  model?: string;
  key?: string;
  /** Re-point the model source: `"managed"`, a `cred_…` id, or `null` to clear (org default). Mutually exclusive with `key`. */
  credential?: CredentialRef | null;
  limits?: Limits;
}

export interface Page<T> { data: T[]; nextCursor?: string | null; }

/** The Slack app manifest to create in Slack (from `slackManifest`). */
export interface SlackManifest {
  manifest: Record<string, unknown>;
  createUrl: string;
  steps?: unknown;
  status: string;
}

/** A Slack connection's public state — never carries the bot token / signing secret. */
export interface SlackConnection {
  id: string;
  agentId: string;
  status: string; // pending | active | revoked | error
  slackAppId?: string | null;
  teamId?: string | null;
  accountLogin?: string | null;
  openUrl?: string | null;
}

/** The three values pasted back from Slack to finalize a connection. */
export interface ConnectSlackParams {
  appId: string;
  botToken: string;
  signingSecret: string;
}

/** One browser-safe OAuth start for the OpenComputer-operated Slack app. */
export interface ManagedSlackAuthorization {
  mode: "managed";
  status: "pending";
  authorizeUrl: string;
  expiresAt: string;
}

/** Public state for the OpenComputer-operated Slack app. Never includes credentials. */
export interface ManagedSlackConnection {
  mode: "managed";
  status: "active" | "disconnected" | "error" | "revoked";
  workspace?: { id: string; name?: string | null } | null;
  app?: { id: string; handle?: string | null } | null;
  openUrl?: string | null;
  connectedAt?: string | null;
  errorCode?: string | null;
}

/** One current owner-scoped workspace claim for pre-OAuth conflict discovery. */
export interface ManagedSlackWorkspaceConnection extends ManagedSlackConnection {
  agent: { id: string; name: string };
}

/** Which repositories an agent may use as working sources. */
export type RepositoryAccessPolicy =
  | { mode: "all" }
  | { mode: "selected"; repositoryIds: string[] };

/** Current state of the owner-bound OpenComputer GitHub App grant. */
export interface RepositoryAccessGrant {
  status: "active" | "not_installed" | "unavailable";
  account: string | null;
  repositorySelection: "all" | "selected" | null;
  installUrl: string;
  configureUrl: string | null;
  truncated: boolean;
}

/** One repository currently usable under both the GitHub grant and agent policy. */
export interface RepositoryAccessRepository {
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** A selected repository absent from the current complete GitHub grant view. */
export interface UnavailableSelectedRepository {
  id: string;
  fullName: string;
}

/** Agent policy composed with the owner's current GitHub App grant. */
export interface RepositoryAccess {
  policy: RepositoryAccessPolicy;
  grant: RepositoryAccessGrant;
  /** `null` means the grant could not be read; an empty array is a known-empty view. */
  effectiveRepositories: RepositoryAccessRepository[] | null;
  /** Authoritative only when `grant.truncated` is false. */
  unavailableSelectedRepositories: UnavailableSelectedRepository[];
}

/** Reusable agents — the "what" a session runs. */
export class Agents {
  /** Deploy behavior (inline or from a linked repo) — each deployment produces a revision. */
  readonly deployments: Deployments;
  /** Immutable, numbered revisions + rollback / promote (set the active revision). */
  readonly revisions: Revisions;
  /** Active-pointer audit log. */
  readonly activations: Activations;
  /** The active revision's skills (zip upload / remove). */
  readonly skills: Skills;
  /** Repo linkage for push-to-deploy. */
  readonly deploymentSource: DeploymentSourceResource;
  /** Cron for agents — schedules that fire a session per slot (015). */
  readonly schedules: Schedules;
  /** Review and import an agent from an existing repository. */
  readonly repository: AgentRepository;
  /** Named, revocable URLs for external systems that should only start this agent. */
  readonly hooks: AgentHooks;

  constructor(private readonly http: Http) {
    this.deployments = new Deployments(http);
    this.revisions = new Revisions(http);
    this.activations = new Activations(http);
    this.skills = new Skills(http);
    this.deploymentSource = new DeploymentSourceResource(http);
    this.schedules = new Schedules(http);
    this.repository = new AgentRepository(http);
    this.hooks = new AgentHooks(http);
  }

  create(params: CreateAgentParams): Promise<Agent> {
    // Idempotent by name server-side → safe to auto-retry transient failures.
    return this.http.request("POST", "/agents", { body: params, idempotent: true });
  }
  get(id: string): Promise<Agent> {
    return this.http.request("GET", `/agents/${id}`);
  }
  update(id: string, params: UpdateAgentParams): Promise<Agent> {
    return this.http.request("PATCH", `/agents/${id}`, { body: params });
  }
  list(params: { limit?: number; cursor?: string } = {}): Promise<Page<Agent>> {
    return this.http.request("GET", "/agents", { query: params as Query });
  }

  // ── Working repositories (agent policy ∩ owner GitHub App grant) ──

  /** Read the agent's working-repository policy and current effective grant view. */
  getRepositoryAccess(agentId: string): Promise<RepositoryAccess> {
    return this.http.request("GET", `/agents/${agentId}/repository-access`);
  }

  /** Atomically replace the agent's working-repository policy. */
  updateRepositoryAccess(
    agentId: string,
    policy: RepositoryAccessPolicy,
  ): Promise<RepositoryAccess> {
    return this.http.request("PUT", `/agents/${agentId}/repository-access`, {
      body: policy,
      idempotent: true,
    });
  }

  // ── Slack (give the agent its own @handle; BYO app, 1 app ⟷ 1 agent ⟷ 1 workspace) ──

  /** Start the connect intent → returns the app manifest to create in Slack. Pass
   *  `reconnect: true` to replace an already-active connection (otherwise 409). */
  slackManifest(id: string, opts: { reconnect?: boolean } = {}): Promise<SlackManifest> {
    return this.http.request("POST", `/agents/${id}/slack/manifest`, { body: opts });
  }
  /** Finalize the connection with the three values Slack shows after install.
   *  (The HTTP layer converts appId → app_id, etc. on the wire.) */
  connectSlack(id: string, params: ConnectSlackParams): Promise<SlackConnection> {
    return this.http.request("POST", `/agents/${id}/slack`, { body: params });
  }
  /** Current connection (no secrets). */
  getSlack(id: string): Promise<SlackConnection> {
    return this.http.request("GET", `/agents/${id}/slack`);
  }
  /** Disconnect — purges the stored secrets and stops routing. */
  disconnectSlack(id: string): Promise<{ ok: boolean }> {
    return this.http.request("DELETE", `/agents/${id}/slack`);
  }

  // ── Managed Slack (OpenComputer-operated onboarding app) ──

  /** Start managed Slack OAuth. The optional deployment id is validated return
   *  context, never a caller-controlled redirect. */
  authorizeManagedSlack(
    id: string,
    opts: { returnDeploymentId?: string } = {},
  ): Promise<ManagedSlackAuthorization | ManagedSlackConnection> {
    return this.http.request("POST", `/agents/${id}/slack/managed/authorize`, {
      body: opts,
    });
  }
  /** Current managed installation/connection state. */
  getManagedSlack(id: string): Promise<ManagedSlackConnection> {
    return this.http.request("GET", `/agents/${id}/slack/managed`);
  }
  /** Current workspaces already routed to this owner's agents. */
  listManagedSlackConnections(): Promise<Page<ManagedSlackWorkspaceConnection>> {
    return this.http.request("GET", "/slack/managed/connections");
  }
  /** Disconnect this agent without uninstalling the shared app from Slack. */
  disconnectManagedSlack(id: string): Promise<{ ok: true; status: "disconnected" }> {
    return this.http.request("DELETE", `/agents/${id}/slack/managed`);
  }

  /**
   * Node-only sugar: bundle a local agent directory (`agent.toml` + `prompt.md` + optional
   * `skills/`) and deploy it inline. Resolve the target agent from `opts.agentId` or the manifest's
   * `[agent].id`. Uses dynamic `node:fs`/`node:path` imports so the browser build never loads them.
   */
  async deploy(dir = ".", opts: { agentId?: string; activate?: boolean } = {}): Promise<{ deployment: Deployment }> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const read = (rel: string) => fs.readFile(path.join(dir, rel), "utf8");

    let toml = "";
    try { toml = await read("agent.toml"); } catch { /* optional when agentId is passed */ }
    const agentId = opts.agentId ?? tomlSectionValue(toml, "agent", "id");
    if (!agentId) throw new Error("oc.agents.deploy: pass { agentId } or set [agent].id in agent.toml");

    let prompt: string;
    try { prompt = await read("prompt.md"); }
    catch { throw new Error("oc.agents.deploy: prompt.md is required in the agent directory"); }
    const model = tomlTopLevel(toml, "model");

    const skills: InlineSkillFile[] = [];
    await walkSkills(fs, path, path.join(dir, "skills"), path.join(dir, "skills"), skills);

    return this.deployments.create(agentId, {
      input: { type: "inline", prompt, model, skills: skills.length ? skills : undefined },
      activate: opts.activate,
    });
  }
}

// ── agent.toml helpers (minimal — the manifest is flat; no TOML dep) ──

/** A top-level `key = "value"` before the first [section]. */
function tomlTopLevel(toml: string, key: string): string | undefined {
  const head = toml.split(/^\s*\[/m)[0];
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m").exec(head)?.[1];
}

/** A `key = "value"` inside `[section]`. */
function tomlSectionValue(toml: string, section: string, key: string): string | undefined {
  const sec = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?:\\n\\s*\\[|$)`).exec(toml)?.[1];
  if (!sec) return undefined;
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m").exec(sec)?.[1];
}

/** Recursively read `skills/` into InlineSkillFile[] (paths relative to the skills root). */
async function walkSkills(
  fs: typeof import("node:fs/promises"),
  path: typeof import("node:path"),
  root: string,
  dir: string,
  out: InlineSkillFile[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; } // no skills/ directory
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await walkSkills(fs, path, root, full, out); continue; }
    if (!e.isFile()) continue;
    const content = await fs.readFile(full, "utf8");
    const st = await fs.stat(full);
    out.push({ path: path.relative(root, full).split(path.sep).join("/"), content, mode: (st.mode & 0o111) ? 0o755 : 0o644 });
  }
}
