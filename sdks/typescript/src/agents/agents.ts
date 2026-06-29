import type { Http, Query } from "./http.js";
import type { Agent, Limits } from "./types.js";

export interface CreateAgentParams {
  name: string;
  prompt: string;
  model: string;
  runtime?: string;
  /** Model provider key for the runtime (Anthropic for `claude`, OpenAI for `codex`), stored as a sealed credential. Or pass `credential`, or rely on the org default. */
  key?: string;
  credential?: string;
  limits?: Limits;
}

export interface UpdateAgentParams {
  prompt?: string;
  model?: string;
  key?: string;
  credential?: string;
  limits?: Limits;
}

export interface Page<T> { data: T[]; nextCursor?: string | null; }

/** The Slack app manifest to create in Slack (from `slackManifest`). */
export interface SlackManifest {
  manifest: Record<string, unknown>;
  create_url: string;
  steps?: unknown;
  status: string;
}

/** A Slack connection's public state — never carries the bot token / signing secret. */
export interface SlackConnection {
  id: string;
  agent_id: string;
  status: string; // pending | active | revoked | error
  slack_app_id?: string | null;
  team_id?: string | null;
  account_login?: string | null;
}

/** The three values pasted back from Slack to finalize a connection. */
export interface ConnectSlackParams {
  app_id: string;
  bot_token: string;
  signing_secret: string;
}

/** Reusable agents — the "what" a session runs. */
export class Agents {
  constructor(private readonly http: Http) {}

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

  // ── Slack (give the agent its own @handle; BYO app, 1 app ⟷ 1 agent ⟷ 1 workspace) ──

  /** Start the connect intent → returns the app manifest to create in Slack. Pass
   *  `reconnect: true` to replace an already-active connection (otherwise 409). */
  slackManifest(id: string, opts: { reconnect?: boolean } = {}): Promise<SlackManifest> {
    return this.http.request("POST", `/agents/${id}/slack/manifest`, { body: opts });
  }
  /** Finalize the connection with the three values Slack shows after install. */
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
}
