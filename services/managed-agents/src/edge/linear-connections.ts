// Linear agent connections (design 018 "Connection", work 037 stream S1).
//
// A connection is one customer-created Linear app installed with
// `actor=app` in one workspace, bound to one project environment and one
// agent. This module owns its storage in the Account object, the OAuth
// exchange, token refresh, the revision lifecycle and health. It runs inside
// the Account object; tokens never leave it except through `accessToken`.
//
// Storage: `linear_connections` holds the non-secret facts; the secrets
// (webhook token, client secret, signing secret, access and refresh tokens)
// are one encrypted JSON blob in the `connections` twin row with
// `provider = 'linear'`, as Slack's are. `linear_oauth_states` holds the
// hashes of issued authorization nonces.
//
// Revision: every write that changes credentials, status or routing advances
// `revision` (create, credentials, authorization, refresh, revocation,
// disconnect). Health facts (`recordEvent`, `updateTeams`) do not. A write
// that was computed from a read (a refresh, a credentials merge, a code
// exchange) commits only if the revision it read is still current, so a
// refresh that completes after a disconnect is discarded.

import type {
  LinearConnection,
  LinearConnectionCredentialsInput,
  LinearConnectionStatus,
  ProjectEnvironmentName,
} from "../protocol.js";
import type {
  LinearConnectionStore,
  LinearGraphqlRequest,
  LinearGraphqlResult,
  LinearTokenResult,
  LinearUnavailableReason,
} from "./linear-contract.js";

/** Linear's GraphQL endpoint: the only request the app token is used for. */
export const LINEAR_GRAPHQL_ORIGIN = "https://api.linear.app";
export const LINEAR_GRAPHQL_PATH = "/graphql";

export const LINEAR_GRAPHQL_URL = `${LINEAR_GRAPHQL_ORIGIN}${LINEAR_GRAPHQL_PATH}`;
export const LINEAR_TOKEN_URL = `${LINEAR_GRAPHQL_ORIGIN}/oauth/token`;
export const LINEAR_REVOKE_URL = `${LINEAR_GRAPHQL_ORIGIN}/oauth/revoke`;
export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_CREATE_APP_URL =
  "https://linear.app/settings/api/applications/new";
export const LINEAR_SCOPES = [
  "read",
  "write",
  "app:assignable",
  "app:mentionable",
] as const;
/** The webhook categories the creation link enables. */
export const LINEAR_WEBHOOK_RESOURCE_TYPES = [
  "AgentSessionEvent",
  "PermissionChange",
  "OAuthAuthorization",
] as const;

/** Refresh when the access token expires within this window. */
export const LINEAR_REFRESH_MARGIN_MS = 5 * 60_000;
export const LINEAR_OAUTH_STATE_TTL_MS = 30 * 60_000;
const LINEAR_REQUEST_TIMEOUT_MS = 15_000;
const LINEAR_APP_NAME_MAX = 64;

const CONNECTION_ID = /^lc_[a-f0-9]{32}$/;
const WEBHOOK_TOKEN = /^[a-f0-9]{64}$/;
const OAUTH_CODE = /^[A-Za-z0-9._~-]{1,512}$/;
const CREDENTIAL_VALUE = /^[\x21-\x7e]{1,512}$/;

// ── Identifiers, names and URLs ───────────────────────────────────────────────

export function newLinearConnectionId(): string {
  return `lc_${randomHex(16)}`;
}

/** The webhook path credential. Only its SHA-256 is stored outside the encrypted blob. */
export function newLinearWebhookToken(): string {
  return randomHex(32);
}

export function isLinearConnectionId(value: string): boolean {
  return CONNECTION_ID.test(value);
}

/** The route object that maps an ingress URL to its account: `linear:<connectionId>`. */
export function linearRouteName(connectionId: string): string {
  return `linear:${connectionId}`;
}

export type LinearAppNameCheck =
  | { ok: true; name: string }
  | { ok: false; code: "invalid_linear_app_name" | "linear_app_name_reserved"; message: string };

/**
 * Linear refuses app names that contain "Linear"; refusing here keeps the
 * customer from discovering that on Linear's create page.
 */
export function checkLinearAppName(value: unknown): LinearAppNameCheck {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (
    !name ||
    name.length > LINEAR_APP_NAME_MAX ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    return {
      ok: false,
      code: "invalid_linear_app_name",
      message: `The agent's name must be between 1 and ${String(LINEAR_APP_NAME_MAX)} characters`,
    };
  }
  if (/linear/i.test(name)) {
    return {
      ok: false,
      code: "linear_app_name_reserved",
      message: 'Linear does not allow app names that contain "Linear"; choose another name',
    };
  }
  return { ok: true, name };
}

export function linearWebhookUrl(
  origin: string,
  connectionId: string,
  webhookToken: string,
): string {
  return new URL(
    `/v1/webhooks/linear/${encodeURIComponent(connectionId)}/${webhookToken}`,
    origin,
  ).toString();
}

/** Linear's prefilled create-app page (work 037, "Linear contract, compact"). */
export function linearCreateAppUrl(input: {
  name: string;
  redirectUri: string;
  webhookUrl: string;
}): string {
  const url = new URL(LINEAR_CREATE_APP_URL);
  url.searchParams.set("distribution", "private");
  url.searchParams.set("oauth.client_name", input.name);
  url.searchParams.set("oauth.redirect_uris", input.redirectUri);
  url.searchParams.set("webhook.enabled", "true");
  url.searchParams.set("webhook.url", input.webhookUrl);
  for (const type of LINEAR_WEBHOOK_RESOURCE_TYPES) {
    url.searchParams.append("webhook.resourceTypes", type);
  }
  return url.toString();
}

export function linearAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", LINEAR_SCOPES.join(","));
  url.searchParams.set("state", input.state);
  url.searchParams.set("actor", "app");
  return url.toString();
}

// ── Ingress route (for stream S2) ─────────────────────────────────────────────

/** What a `linear:<connectionId>` route object holds; Slack's `ChannelRoute` shape. */
export interface LinearRoute {
  accountId: string;
  connectionId: string;
  webhookTokenHash: string;
  provider?: string;
  revision?: number;
}

/** The part of the route object namespace the ingress helper needs. */
export interface LinearRouteNamespace {
  getByName(name: string): {
    getChannelRoute(): Promise<LinearRoute | null>;
  };
}

/**
 * Resolve an ingress URL's `connectionId` and path token to the account that
 * owns the connection, or null. The token is compared by SHA-256 in constant
 * time against the route object's hash; malformed ids and tokens are refused
 * before any Durable Object is addressed. Stream S2 calls this first on
 * `POST /v1/webhooks/linear/:connectionId/:token`, then verifies the HMAC
 * inside the Account object with `linearConnections.signingSecret`.
 */
export async function resolveLinearWebhookRoute(
  accounts: LinearRouteNamespace,
  connectionId: string,
  webhookToken: string,
): Promise<{ accountId: string; connectionId: string; revision: number } | null> {
  if (!CONNECTION_ID.test(connectionId) || !WEBHOOK_TOKEN.test(webhookToken)) {
    return null;
  }
  const route = await accounts
    .getByName(linearRouteName(connectionId))
    .getChannelRoute();
  if (
    !route ||
    route.connectionId !== connectionId ||
    (route.provider !== undefined && route.provider !== "linear")
  ) {
    return null;
  }
  const matches = constantTimeEqual(
    route.webhookTokenHash,
    await sha256Hex(webhookToken),
  );
  return matches
    ? {
        accountId: route.accountId,
        connectionId: route.connectionId,
        revision: route.revision ?? 0,
      }
    : null;
}

// ── Storage ───────────────────────────────────────────────────────────────────

/** Called once from the Account object's constructor. */
export function ensureLinearConnectionSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS linear_connections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      client_id TEXT,
      app_user_id TEXT,
      organization_id TEXT,
      status TEXT NOT NULL,
      access_expires_at TEXT,
      verified_at TEXT,
      verification_error TEXT,
      last_event_at TEXT,
      teams_json TEXT,
      -- Not secret: where the webhook URL and the creation link point.
      webhook_origin TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- One connection per app and one per binding, among connections that
    -- are not disconnected: a disconnect releases both, so the same app can
    -- be connected again and the history stays.
    CREATE UNIQUE INDEX IF NOT EXISTS linear_connections_client
      ON linear_connections(client_id)
      WHERE client_id IS NOT NULL AND status != 'disconnected';
    CREATE UNIQUE INDEX IF NOT EXISTS linear_connections_binding
      ON linear_connections(project_id, environment, agent_id)
      WHERE status != 'disconnected';
    CREATE INDEX IF NOT EXISTS linear_connections_project
      ON linear_connections(project_id, environment, created_at);
    CREATE TABLE IF NOT EXISTS linear_oauth_states (
      nonce_hash TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
  `);
}

interface LinearConnectionRow {
  [key: string]: SqlStorageValue;
  id: string;
  project_id: string;
  environment: string;
  agent_id: string;
  name: string;
  client_id: string | null;
  app_user_id: string | null;
  organization_id: string | null;
  status: string;
  access_expires_at: string | null;
  verified_at: string | null;
  verification_error: string | null;
  last_event_at: string | null;
  teams_json: string | null;
  webhook_origin: string;
  redirect_uri: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface LinearOAuthStateRow {
  [key: string]: SqlStorageValue;
  nonce_hash: string;
  connection_id: string;
  revision: number;
  expires_at: string;
  used_at: string | null;
}

/** The encrypted blob. Never logged, never returned. */
interface LinearCredentials {
  webhookToken: string;
  clientSecret?: string;
  signingSecret?: string;
  accessToken?: string;
  refreshToken?: string;
}

export type LinearConnectionHealthState =
  | "awaiting_credentials"
  | "awaiting_authorization"
  | "waiting_for_first_delegation"
  | "receiving"
  | "revoked";

export interface LinearConnectionHealth {
  state: LinearConnectionHealthState;
  message: string;
  lastEventAt?: string;
}

export type LinearConnectionWithHealth = LinearConnection & {
  health: LinearConnectionHealth;
};

export interface CreateLinearConnectionRecord {
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId: string;
  name: string;
  webhookToken: string;
  /** Where the webhook URL points: the origin the create request arrived on. */
  webhookOrigin: string;
  redirectUri: string;
}

export type CreateLinearConnectionOutcome =
  | {
      outcome: "created" | "reset";
      connection: LinearConnection;
      revision: number;
    }
  | { outcome: "bound"; connection: LinearConnection };

export type LinearCredentialsOutcome =
  | { outcome: "updated"; connection: LinearConnection }
  | { outcome: "not_found" }
  | { outcome: "client_in_use" }
  | { outcome: "connected_to_another_app" }
  | { outcome: "changed" };

export type LinearAuthorizationIssue =
  | {
      outcome: "issued";
      clientId: string;
      redirectUri: string;
      expiresAt: string;
    }
  | { outcome: "not_found" }
  | { outcome: "needs_credentials" };

export type LinearAuthorizationResult =
  | "connected"
  | "denied"
  | "failed"
  | "expired"
  | "superseded"
  | "used";

export type LinearAuthorizationCompletion =
  | { outcome: "missing" }
  | {
      outcome: LinearAuthorizationResult;
      connection: { id: string; projectId: string; environment: ProjectEnvironmentName };
    };

export type LinearDisconnectOutcome =
  | { outcome: "disconnected"; connection: LinearConnection; revoked: boolean }
  | { outcome: "not_found" };

export interface LinearConnectionStoreDeps {
  /** The Account object's storage; read at call time. */
  storage: () => Pick<DurableObjectStorage, "sql" | "transactionSync">;
  encrypt(value: string): Promise<{ ciphertext: string; iv: string }>;
  decrypt(ciphertext: string, iv: string): Promise<string>;
  now?: () => number;
}

type Fetched =
  | { kind: "response"; response: Response }
  | { kind: "network"; message: string };

/**
 * `LinearConnectionStore` (work 037 "Between streams") plus the lifecycle
 * the private routes drive. One instance per Account object.
 */
export class LinearConnections implements LinearConnectionStore {
  /** One refresh at a time per connection; concurrent callers share it. */
  private readonly refreshing = new Map<string, Promise<TokenRead>>();

  constructor(private readonly deps: LinearConnectionStoreDeps) {}

  // ── LinearConnectionStore ──────────────────────────────────────────────────

  get(connectionId: string): LinearConnection | null {
    const row = this.row(connectionId);
    return row ? connectionView(row, null) : null;
  }

  forAgent(
    projectId: string,
    environment: ProjectEnvironmentName,
    agentId: string,
  ): LinearConnection | null {
    const row = this.sql
      .exec<LinearConnectionRow>(
        `SELECT * FROM linear_connections
         WHERE project_id = ? AND environment = ? AND agent_id = ?
           AND status != 'disconnected'
         LIMIT 1`,
        projectId,
        environment,
        agentId,
      )
      .toArray()[0];
    return row ? connectionView(row, null) : null;
  }

  async signingSecret(connectionId: string): Promise<string | null> {
    const row = this.row(connectionId);
    if (!row || row.status === "disconnected") return null;
    return (await this.credentials(connectionId))?.signingSecret ?? null;
  }

  async graphql(
    connectionId: string,
    request: LinearGraphqlRequest,
  ): Promise<LinearGraphqlResult> {
    let read = await this.token(connectionId, null);
    for (let attempt = 0; ; attempt += 1) {
      if (read.result.outcome !== "token") return read.result;
      const fetched = await linearFetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${read.result.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: request.query,
          ...(request.variables ? { variables: request.variables } : {}),
        }),
      });
      if (fetched.kind === "network") {
        return { outcome: "transient", message: fetched.message };
      }
      const response = fetched.response;
      const body = await readJsonBody(response);
      if (isAuthenticationFailure(response.status, body) && attempt === 0) {
        // Once: refresh unless another caller already replaced this token.
        read = await this.token(connectionId, read.revision);
        continue;
      }
      return graphqlResult(response, body);
    }
  }

  async accessToken(connectionId: string): Promise<LinearTokenResult> {
    return (await this.token(connectionId, null)).result;
  }

  recordEvent(connectionId: string, at: string): void {
    this.sql.exec(
      `UPDATE linear_connections
       SET verified_at = COALESCE(verified_at, ?),
           last_event_at = CASE
             WHEN last_event_at IS NULL OR last_event_at < ? THEN ?
             ELSE last_event_at END
       WHERE id = ? AND status != 'disconnected'`,
      at,
      at,
      at,
      connectionId,
    );
  }

  markRevoked(connectionId: string, at: string): void {
    this.deps.storage().transactionSync(() => {
      const changed = this.sql
        .exec<{ id: string }>(
          `UPDATE linear_connections
           SET status = 'revoked', revision = revision + 1, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'connected')
           RETURNING id`,
          at,
          connectionId,
        )
        .toArray().length;
      if (changed) {
        this.sql.exec(
          `UPDATE connections SET status = 'revoked', updated_at = ?
           WHERE id = ? AND provider = 'linear'`,
          at,
          connectionId,
        );
      }
    });
  }

  updateTeams(
    connectionId: string,
    teams: { allPublic: boolean; teamIds: string[] },
  ): void {
    this.sql.exec(
      `UPDATE linear_connections SET teams_json = ?
       WHERE id = ? AND status != 'disconnected'`,
      JSON.stringify({
        allPublic: teams.allPublic,
        teamIds: [...new Set(teams.teamIds)].sort(),
      }),
      connectionId,
    );
  }

  // ── Lifecycle (private routes) ─────────────────────────────────────────────

  /**
   * Allocate a pending connection for a binding. A binding that already has
   * a pending connection is reset to the new name and token (the earlier
   * creation link is dead; the revision advances so the route republishes);
   * a connected or revoked one is refused.
   */
  async create(
    input: CreateLinearConnectionRecord,
  ): Promise<CreateLinearConnectionOutcome> {
    const encrypted = await this.deps.encrypt(
      JSON.stringify({ webhookToken: input.webhookToken } satisfies LinearCredentials),
    );
    const timestamp = this.timestamp();
    return this.deps.storage().transactionSync(() => {
      const existing = this.sql
        .exec<LinearConnectionRow>(
          `SELECT * FROM linear_connections
           WHERE project_id = ? AND environment = ? AND agent_id = ?
             AND status != 'disconnected'
           LIMIT 1`,
          input.projectId,
          input.environment,
          input.agentId,
        )
        .toArray()[0];
      if (existing && existing.status !== "pending") {
        return { outcome: "bound", connection: connectionView(existing, null) };
      }
      let id: string;
      if (existing) {
        id = existing.id;
        this.sql.exec(
          `UPDATE linear_connections
           SET name = ?, client_id = NULL, app_user_id = NULL,
               organization_id = NULL, access_expires_at = NULL,
               verified_at = NULL, verification_error = NULL,
               last_event_at = NULL, teams_json = NULL,
               webhook_origin = ?, redirect_uri = ?,
               revision = revision + 1, updated_at = ?
           WHERE id = ?`,
          input.name,
          input.webhookOrigin,
          input.redirectUri,
          timestamp,
          id,
        );
        this.sql.exec(
          `UPDATE connections
           SET display_name = ?, external_account_id = NULL,
               credential_ciphertext = ?, credential_iv = ?,
               status = 'pending', updated_at = ?
           WHERE id = ? AND provider = 'linear'`,
          input.name,
          encrypted.ciphertext,
          encrypted.iv,
          timestamp,
          id,
        );
        this.sql.exec(
          "DELETE FROM linear_oauth_states WHERE connection_id = ?",
          id,
        );
      } else {
        id = newLinearConnectionId();
        this.sql.exec(
          `INSERT INTO linear_connections (
             id, project_id, environment, agent_id, name, status,
             webhook_origin, redirect_uri, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?)`,
          id,
          input.projectId,
          input.environment,
          input.agentId,
          input.name,
          input.webhookOrigin,
          input.redirectUri,
          timestamp,
          timestamp,
        );
        this.sql.exec(
          `INSERT INTO connections (
             id, kind, provider, label, owner_user_id, agent_id, alias,
             external_account_id, display_name, scopes_json,
             credential_ciphertext, credential_iv, oauth_state_hash,
             status, created_at, updated_at
           ) VALUES (?, 'channel', 'linear', 'linear', '', ?, ?, NULL, ?, ?,
                     ?, ?, NULL, 'pending', ?, ?)`,
          id,
          input.agentId,
          input.environment,
          input.name,
          JSON.stringify(LINEAR_SCOPES),
          encrypted.ciphertext,
          encrypted.iv,
          timestamp,
          timestamp,
        );
      }
      const row = this.row(id)!;
      return {
        outcome: existing ? "reset" : "created",
        connection: connectionView(row, input.webhookToken),
        revision: row.revision,
      };
    });
  }

  /**
   * Store the app's client id, client secret and webhook signing secret.
   * A connected connection accepts only its own client id (a rotated secret);
   * a different app on a pending or revoked connection starts it over as
   * pending. A client id held by another live connection is refused.
   */
  async setCredentials(
    connectionId: string,
    input: LinearConnectionCredentialsInput,
  ): Promise<LinearCredentialsOutcome> {
    const row = this.row(connectionId);
    if (!row || row.status === "disconnected") return { outcome: "not_found" };
    const sameApp = row.client_id === input.clientId;
    if (row.status === "connected" && !sameApp) {
      return { outcome: "connected_to_another_app" };
    }
    if (this.clientHeldElsewhere(input.clientId, connectionId)) {
      return { outcome: "client_in_use" };
    }
    const current = await this.credentials(connectionId);
    if (!current) return { outcome: "not_found" };
    const next: LinearCredentials = sameApp
      ? { ...current, clientSecret: input.clientSecret, signingSecret: input.signingSecret }
      : {
          webhookToken: current.webhookToken,
          clientSecret: input.clientSecret,
          signingSecret: input.signingSecret,
        };
    const encrypted = await this.deps.encrypt(JSON.stringify(next));
    const timestamp = this.timestamp();
    return this.deps.storage().transactionSync((): LinearCredentialsOutcome => {
      if (this.clientHeldElsewhere(input.clientId, connectionId)) {
        return { outcome: "client_in_use" };
      }
      const changed = this.sql
        .exec<{ id: string }>(
          sameApp
            ? `UPDATE linear_connections
               SET revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND status != 'disconnected'
               RETURNING id`
            : `UPDATE linear_connections
               SET client_id = ?, status = 'pending', app_user_id = NULL,
                   organization_id = NULL, access_expires_at = NULL,
                   verified_at = NULL, verification_error = NULL,
                   last_event_at = NULL, teams_json = NULL,
                   revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND status != 'disconnected'
               RETURNING id`,
          ...(sameApp
            ? [timestamp, connectionId, row.revision]
            : [input.clientId, timestamp, connectionId, row.revision]),
        )
        .toArray().length;
      if (!changed) return { outcome: "changed" };
      this.sql.exec(
        `UPDATE connections
         SET credential_ciphertext = ?, credential_iv = ?,
             status = CASE WHEN ? THEN status ELSE 'pending' END,
             external_account_id = CASE WHEN ? THEN external_account_id ELSE NULL END,
             updated_at = ?
         WHERE id = ? AND provider = 'linear'`,
        encrypted.ciphertext,
        encrypted.iv,
        sameApp ? 1 : 0,
        sameApp ? 1 : 0,
        timestamp,
        connectionId,
      );
      return {
        outcome: "updated",
        connection: connectionView(this.row(connectionId)!, current.webhookToken),
      };
    });
  }

  /** Record an authorization nonce bound to the connection's current revision. */
  async issueAuthorization(
    connectionId: string,
    nonceHash: string,
  ): Promise<LinearAuthorizationIssue> {
    const row = this.row(connectionId);
    if (!row || row.status === "disconnected") return { outcome: "not_found" };
    const credentials = await this.credentials(connectionId);
    if (!row.client_id || !credentials?.clientSecret) {
      return { outcome: "needs_credentials" };
    }
    const now = this.now();
    const expiresAt = new Date(now + LINEAR_OAUTH_STATE_TTL_MS).toISOString();
    this.deps.storage().transactionSync(() => {
      this.sql.exec(
        "DELETE FROM linear_oauth_states WHERE expires_at <= ?",
        new Date(now).toISOString(),
      );
      this.sql.exec(
        `INSERT INTO linear_oauth_states (nonce_hash, connection_id, revision, expires_at)
         VALUES (?, ?, ?, ?)`,
        nonceHash,
        connectionId,
        row.revision,
        expiresAt,
      );
    });
    return {
      outcome: "issued",
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      expiresAt,
    };
  }

  /**
   * The OAuth callback's work: claim the nonce once, exchange the code at
   * Linear, read the app user and workspace with the new token, and commit
   * only if the connection's revision is the one the authorization was
   * issued at. A superseded exchange revokes the token it obtained.
   */
  async completeAuthorization(input: {
    nonceHash: string;
    code: string | null;
    denied: boolean;
  }): Promise<LinearAuthorizationCompletion> {
    const now = this.now();
    const claimed = this.deps.storage().transactionSync(() => {
      const state = this.sql
        .exec<LinearOAuthStateRow>(
          "SELECT * FROM linear_oauth_states WHERE nonce_hash = ?",
          input.nonceHash,
        )
        .toArray()[0];
      if (!state) return null;
      if (!state.used_at) {
        this.sql.exec(
          "UPDATE linear_oauth_states SET used_at = ? WHERE nonce_hash = ?",
          new Date(now).toISOString(),
          input.nonceHash,
        );
      }
      return { state, row: this.row(state.connection_id) };
    });
    if (!claimed?.row) return { outcome: "missing" };
    const { state, row } = claimed;
    const target = {
      id: row.id,
      projectId: row.project_id,
      environment: row.environment as ProjectEnvironmentName,
    };
    const finish = (outcome: LinearAuthorizationResult, error?: string) => {
      if (error) this.recordVerificationError(row.id, state.revision, error);
      return { outcome, connection: target };
    };
    if (state.used_at) return finish("used");
    if (Date.parse(state.expires_at) <= now) return finish("expired");
    if (row.status === "disconnected" || row.revision !== state.revision) {
      return finish("superseded");
    }
    if (input.denied || !input.code) return finish("denied", "authorization_denied");
    if (!OAUTH_CODE.test(input.code) || !row.client_id) {
      return finish("failed", "authorization_failed");
    }
    const credentials = await this.credentials(row.id);
    if (!credentials?.clientSecret) return finish("failed", "authorization_failed");

    const grant = await requestToken({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: row.redirect_uri,
      client_id: row.client_id,
      client_secret: credentials.clientSecret,
    });
    if (grant.outcome !== "granted") {
      logLinear("warn", "linear.authorization_exchange_failed", row.id, {
        outcome: grant.outcome,
        ...(grant.status ? { status: grant.status } : {}),
      });
      return finish("failed", "authorization_failed");
    }
    const viewer = await readViewer(grant.accessToken);
    if (!viewer) {
      await revokeToken(grant.accessToken);
      logLinear("warn", "linear.authorization_viewer_failed", row.id);
      return finish("failed", "authorization_failed");
    }
    const encrypted = await this.deps.encrypt(
      JSON.stringify({
        ...credentials,
        accessToken: grant.accessToken,
        ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      } satisfies LinearCredentials),
    );
    const timestamp = this.timestamp();
    const expiresAt = grant.expiresIn
      ? new Date(this.now() + grant.expiresIn * 1000).toISOString()
      : null;
    const committed = this.deps.storage().transactionSync(() => {
      const changed = this.sql
        .exec<{ id: string }>(
          `UPDATE linear_connections
           SET status = 'connected', app_user_id = ?, organization_id = ?,
               access_expires_at = ?, verification_error = NULL,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND status != 'disconnected'
           RETURNING id`,
          viewer.appUserId,
          viewer.organizationId,
          expiresAt,
          timestamp,
          row.id,
          state.revision,
        )
        .toArray().length;
      if (!changed) return false;
      this.sql.exec(
        `UPDATE connections
         SET credential_ciphertext = ?, credential_iv = ?,
             external_account_id = ?, status = 'connected', updated_at = ?
         WHERE id = ? AND provider = 'linear'`,
        encrypted.ciphertext,
        encrypted.iv,
        viewer.organizationId,
        timestamp,
        row.id,
      );
      return true;
    });
    if (!committed) {
      await revokeToken(grant.accessToken);
      logLinear("info", "linear.authorization_superseded", row.id);
      return finish("superseded");
    }
    logLinear("info", "linear.connected", row.id);
    return finish("connected");
  }

  /** Connections of a project (one environment, or both) with live webhook URLs and health. */
  async list(
    projectId: string,
    environment?: ProjectEnvironmentName,
  ): Promise<LinearConnectionWithHealth[]> {
    const rows = this.sql
      .exec<LinearConnectionRow>(
        `SELECT * FROM linear_connections
         WHERE project_id = ? AND (? IS NULL OR environment = ?)
           AND status != 'disconnected'
         ORDER BY environment, created_at`,
        projectId,
        environment ?? null,
        environment ?? null,
      )
      .toArray();
    const views: LinearConnectionWithHealth[] = [];
    for (const row of rows) {
      const credentials = await this.credentials(row.id);
      views.push({
        ...connectionView(row, credentials?.webhookToken ?? null),
        health: connectionHealth(row, credentials),
      });
    }
    return views;
  }

  /** One connection with its live webhook URL, for the route that just changed it. */
  async view(connectionId: string): Promise<LinearConnectionWithHealth | null> {
    const row = this.row(connectionId);
    if (!row) return null;
    const credentials =
      row.status === "disconnected" ? null : await this.credentials(row.id);
    return {
      ...connectionView(row, credentials?.webhookToken ?? null),
      health: connectionHealth(row, credentials),
    };
  }

  /**
   * Unbind: mark disconnected and advance the revision (an in-flight refresh
   * is then discarded), drop every secret, and revoke the access token at
   * Linear. Revocation is best effort; the connection is disconnected
   * whether or not Linear answers.
   */
  async disconnect(connectionId: string): Promise<LinearDisconnectOutcome> {
    const timestamp = this.timestamp();
    const taken = this.deps.storage().transactionSync(() => {
      const row = this.row(connectionId);
      if (!row || row.status === "disconnected") return null;
      const sealed = this.sealedCredentials(connectionId);
      this.sql.exec(
        `UPDATE linear_connections
         SET status = 'disconnected', access_expires_at = NULL,
             revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        timestamp,
        connectionId,
      );
      this.sql.exec(
        `UPDATE connections
         SET status = 'disconnected', credential_ciphertext = NULL,
             credential_iv = NULL, updated_at = ?
         WHERE id = ? AND provider = 'linear'`,
        timestamp,
        connectionId,
      );
      this.sql.exec(
        "DELETE FROM linear_oauth_states WHERE connection_id = ?",
        connectionId,
      );
      return sealed;
    });
    if (taken === null) return { outcome: "not_found" };
    let revoked = false;
    if (taken) {
      const credentials = parseCredentials(
        await this.deps.decrypt(taken.ciphertext, taken.iv),
      );
      if (credentials?.accessToken) {
        revoked = await revokeToken(credentials.accessToken);
      }
    }
    logLinear("info", "linear.disconnected", connectionId, { revoked });
    return {
      outcome: "disconnected",
      connection: connectionView(this.row(connectionId)!, null),
      revoked,
    };
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /**
   * The current token and the revision it was read at. Refreshes when it
   * expires within the margin, or when `rejectedRevision` names the revision
   * whose token Linear just refused (a 401) and nobody has replaced it since.
   */
  private async token(
    connectionId: string,
    rejectedRevision: number | null,
    attempt: RefreshAttempt | "none" = "first",
  ): Promise<TokenRead> {
    const row = this.row(connectionId);
    const unavailable = unavailableReason(row);
    if (!row || unavailable) {
      return { result: { outcome: "unavailable", reason: unavailable ?? "not_found" }, revision: row?.revision ?? 0 };
    }
    const credentials = await this.credentials(connectionId);
    if (!credentials?.accessToken) {
      return { result: { outcome: "unavailable", reason: "pending" }, revision: row.revision };
    }
    const current = this.row(connectionId);
    if (!current || current.revision !== row.revision) {
      // Written while the blob was being decrypted; read again.
      return this.token(connectionId, rejectedRevision, attempt);
    }
    const expiring =
      row.access_expires_at !== null &&
      Date.parse(row.access_expires_at) - this.now() < LINEAR_REFRESH_MARGIN_MS;
    const rejected = rejectedRevision === row.revision;
    if ((!expiring && !rejected) || !credentials.refreshToken) {
      return {
        result: {
          outcome: "token",
          token: credentials.accessToken,
          expiresAt: row.access_expires_at ?? "",
        },
        revision: row.revision,
      };
    }
    if (attempt === "none") {
      logLinear("warn", "linear.refresh_contended", connectionId);
      return {
        result: {
          outcome: "transient",
          message: "the Linear connection changed during token refresh; retry",
        },
        revision: row.revision,
      };
    }
    return this.refresh(connectionId, row.revision, attempt);
  }

  /**
   * Joins the connection's in-flight refresh, or starts one. `attempt` is
   * "fresh" for the one attempt a refresh may make after losing its revision.
   */
  private refresh(
    connectionId: string,
    observedRevision: number,
    attempt: RefreshAttempt,
  ): Promise<TokenRead> {
    const inflight = this.refreshing.get(connectionId);
    if (inflight) return inflight;
    const release = (): void => {
      if (this.refreshing.get(connectionId) === running) this.refreshing.delete(connectionId);
    };
    // Started a microtask later, so the slot is set before the refresh can release it.
    const running: Promise<TokenRead> = Promise.resolve()
      .then(() => this.runRefresh(connectionId, observedRevision, attempt, release))
      .finally(release);
    this.refreshing.set(connectionId, running);
    return running;
  }

  /**
   * A refresh that lost its revision leaves the in-flight slot first, so the
   * read that follows cannot join (and wait on) itself. The read returns a
   * token someone else stored; a token that still needs a refresh gets one
   * fresh attempt against the current credentials, and a fresh attempt that
   * loses too answers transient instead of trying again.
   */
  private afterConflict(
    connectionId: string,
    attempt: RefreshAttempt,
    release: () => void,
  ): Promise<TokenRead> {
    release();
    return this.token(connectionId, null, attempt === "first" ? "fresh" : "none");
  }

  private async runRefresh(
    connectionId: string,
    observedRevision: number,
    attempt: RefreshAttempt,
    release: () => void,
  ): Promise<TokenRead> {
    const row = this.row(connectionId);
    const unavailable = unavailableReason(row);
    if (!row || unavailable) {
      return { result: { outcome: "unavailable", reason: unavailable ?? "not_found" }, revision: row?.revision ?? 0 };
    }
    if (row.revision !== observedRevision) {
      return this.afterConflict(connectionId, attempt, release);
    }
    const credentials = await this.credentials(connectionId);
    if (!credentials?.refreshToken || !credentials.clientSecret || !row.client_id) {
      return { result: { outcome: "unavailable", reason: "pending" }, revision: row.revision };
    }
    const grant = await requestToken({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: row.client_id,
      client_secret: credentials.clientSecret,
    });
    if (grant.outcome === "transient") {
      logLinear("warn", "linear.refresh_transient", connectionId, {
        ...(grant.status ? { status: grant.status } : {}),
      });
      return {
        result: {
          outcome: "transient",
          message: grant.message,
          ...(grant.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: grant.retryAfterSeconds }
            : {}),
        },
        revision: row.revision,
      };
    }
    if (grant.outcome === "rejected") {
      // The grant is gone (the app was uninstalled, or the refresh token was
      // revoked). Only an authorization can bring it back.
      const timestamp = this.timestamp();
      this.deps.storage().transactionSync(() => {
        const changed = this.sql
          .exec<{ id: string }>(
            `UPDATE linear_connections
             SET status = 'revoked', verification_error = 'refresh_rejected',
                 revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ? AND status = 'connected'
             RETURNING id`,
            timestamp,
            connectionId,
            observedRevision,
          )
          .toArray().length;
        if (changed) {
          this.sql.exec(
            `UPDATE connections SET status = 'revoked', updated_at = ?
             WHERE id = ? AND provider = 'linear'`,
            timestamp,
            connectionId,
          );
        }
      });
      logLinear("warn", "linear.refresh_rejected", connectionId, { status: grant.status });
      const after = this.row(connectionId);
      return {
        result: { outcome: "unavailable", reason: unavailableReason(after) ?? "revoked" },
        revision: after?.revision ?? 0,
      };
    }
    const encrypted = await this.deps.encrypt(
      JSON.stringify({
        ...credentials,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken ?? credentials.refreshToken,
      } satisfies LinearCredentials),
    );
    const timestamp = this.timestamp();
    const expiresAt = grant.expiresIn
      ? new Date(this.now() + grant.expiresIn * 1000).toISOString()
      : null;
    const revision = this.deps.storage().transactionSync(() => {
      const updated = this.sql
        .exec<{ revision: number }>(
          `UPDATE linear_connections
           SET access_expires_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND status = 'connected'
           RETURNING revision`,
          expiresAt,
          timestamp,
          connectionId,
          observedRevision,
        )
        .toArray()[0];
      if (!updated) return null;
      this.sql.exec(
        `UPDATE connections
         SET credential_ciphertext = ?, credential_iv = ?, updated_at = ?
         WHERE id = ? AND provider = 'linear'`,
        encrypted.ciphertext,
        encrypted.iv,
        timestamp,
        connectionId,
      );
      return updated.revision;
    });
    if (revision === null) {
      // The connection was written while Linear answered (a disconnect, a
      // revocation, new credentials). Its result is discarded, and the token
      // it obtained is revoked so nothing holds a credential storage forgot.
      // The slot is free from here: a caller arriving now refreshes against
      // the current credentials instead of waiting on this discarded result.
      release();
      logLinear("info", "linear.refresh_discarded", connectionId);
      await revokeToken(grant.accessToken);
      const after = this.row(connectionId);
      const reason = unavailableReason(after);
      if (!after || reason) {
        return { result: { outcome: "unavailable", reason: reason ?? "not_found" }, revision: after?.revision ?? 0 };
      }
      return this.afterConflict(connectionId, attempt, release);
    }
    return {
      result: { outcome: "token", token: grant.accessToken, expiresAt: expiresAt ?? "" },
      revision,
    };
  }

  // ── Rows and secrets ───────────────────────────────────────────────────────

  private get sql(): SqlStorage {
    return this.deps.storage().sql;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private row(connectionId: string): LinearConnectionRow | null {
    return (
      this.sql
        .exec<LinearConnectionRow>(
          "SELECT * FROM linear_connections WHERE id = ?",
          connectionId,
        )
        .toArray()[0] ?? null
    );
  }

  private clientHeldElsewhere(clientId: string, connectionId: string): boolean {
    return (
      this.sql
        .exec<{ id: string }>(
          `SELECT id FROM linear_connections
           WHERE client_id = ? AND id != ? AND status != 'disconnected'
           LIMIT 1`,
          clientId,
          connectionId,
        )
        .toArray().length > 0
    );
  }

  private sealedCredentials(
    connectionId: string,
  ): { ciphertext: string; iv: string } | undefined {
    const row = this.sql
      .exec<{ credential_ciphertext: string | null; credential_iv: string | null }>(
        `SELECT credential_ciphertext, credential_iv FROM connections
         WHERE id = ? AND provider = 'linear'`,
        connectionId,
      )
      .toArray()[0];
    return row?.credential_ciphertext && row.credential_iv
      ? { ciphertext: row.credential_ciphertext, iv: row.credential_iv }
      : undefined;
  }

  private async credentials(connectionId: string): Promise<LinearCredentials | null> {
    const sealed = this.sealedCredentials(connectionId);
    if (!sealed) return null;
    return parseCredentials(await this.deps.decrypt(sealed.ciphertext, sealed.iv));
  }

  private recordVerificationError(
    connectionId: string,
    revision: number,
    error: string,
  ): void {
    this.sql.exec(
      `UPDATE linear_connections SET verification_error = ?, updated_at = ?
       WHERE id = ? AND revision = ? AND status != 'disconnected'`,
      error,
      this.timestamp(),
      connectionId,
      revision,
    );
  }
}

interface TokenRead {
  result: LinearTokenResult;
  revision: number;
}

/** A refresh's first attempt, or the one fresh attempt after a lost revision. */
type RefreshAttempt = "first" | "fresh";

function unavailableReason(
  row: LinearConnectionRow | null,
): LinearUnavailableReason | null {
  if (!row) return "not_found";
  switch (row.status as LinearConnectionStatus) {
    case "connected":
      return null;
    case "pending":
      return "pending";
    case "revoked":
      return "revoked";
    default:
      return "disconnected";
  }
}

function parseCredentials(value: string): LinearCredentials | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.webhookToken !== "string") return null;
    const credentials: LinearCredentials = { webhookToken: record.webhookToken };
    for (const key of ["clientSecret", "signingSecret", "accessToken", "refreshToken"] as const) {
      const field = record[key];
      if (typeof field === "string" && field) credentials[key] = field;
    }
    return credentials;
  } catch {
    return null;
  }
}

function connectionView(
  row: LinearConnectionRow,
  webhookToken: string | null,
): LinearConnection {
  const webhookUrl =
    webhookToken === null
      ? null
      : linearWebhookUrl(row.webhook_origin, row.id, webhookToken);
  let teams: LinearConnection["teams"];
  if (row.teams_json) {
    try {
      const parsed = JSON.parse(row.teams_json) as { allPublic?: unknown; teamIds?: unknown };
      teams = {
        allPublic: parsed.allPublic === true,
        teamIds: Array.isArray(parsed.teamIds)
          ? parsed.teamIds.filter((id): id is string => typeof id === "string")
          : [],
      };
    } catch {
      teams = undefined;
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    environment: row.environment as ProjectEnvironmentName,
    agentId: row.agent_id,
    name: row.name,
    status: row.status as LinearConnectionStatus,
    ...(row.client_id ? { clientId: row.client_id } : {}),
    ...(row.app_user_id ? { appUserId: row.app_user_id } : {}),
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    ...(webhookUrl
      ? {
          webhookUrl,
          createAppUrl: linearCreateAppUrl({
            name: row.name,
            redirectUri: row.redirect_uri,
            webhookUrl,
          }),
        }
      : {}),
    ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
    ...(row.verification_error ? { verificationError: row.verification_error } : {}),
    ...(row.last_event_at ? { lastEventAt: row.last_event_at } : {}),
    ...(teams ? { teams } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function connectionHealth(
  row: LinearConnectionRow,
  credentials: LinearCredentials | null,
): LinearConnectionHealth {
  if (row.status === "revoked") {
    return {
      state: "revoked",
      message: "The app's access was revoked in Linear. Authorize it again to reconnect.",
      ...(row.last_event_at ? { lastEventAt: row.last_event_at } : {}),
    };
  }
  if (row.status !== "connected") {
    return row.client_id && credentials?.clientSecret
      ? {
          state: "awaiting_authorization",
          message: "Authorize the app in Linear to finish setup.",
        }
      : {
          state: "awaiting_credentials",
          message: "Create the app in Linear, then paste its credentials.",
        };
  }
  if (!row.verified_at || !row.last_event_at) {
    return {
      state: "waiting_for_first_delegation",
      message: "Waiting for the first delegation",
    };
  }
  return {
    state: "receiving",
    message: "First session received",
    lastEventAt: row.last_event_at,
  };
}

// ── Linear HTTP ───────────────────────────────────────────────────────────────

async function linearFetch(url: string, init: RequestInit): Promise<Fetched> {
  try {
    return {
      kind: "response",
      response: await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(LINEAR_REQUEST_TIMEOUT_MS),
      }),
    };
  } catch (error) {
    return {
      kind: "network",
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "Linear did not answer in time"
          : "Linear could not be reached",
    };
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function graphqlErrors(
  body: unknown,
): Array<{ message: string; extensions?: unknown }> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  return errors.map((error: unknown) => {
    const record = (error && typeof error === "object" ? error : {}) as {
      message?: unknown;
      extensions?: unknown;
    };
    return {
      message: typeof record.message === "string" ? record.message : "GraphQL error",
      ...(record.extensions !== undefined ? { extensions: record.extensions } : {}),
    };
  });
}

function errorCodes(body: unknown): string[] {
  return (graphqlErrors(body) ?? [])
    .map((error) =>
      error.extensions && typeof error.extensions === "object"
        ? (error.extensions as { code?: unknown }).code
        : undefined,
    )
    .filter((code): code is string => typeof code === "string");
}

/**
 * A refused token: HTTP 401, or Linear's GraphQL `AUTHENTICATION_ERROR`
 * code. The second form is not verified against Linear (no network in this
 * build); it is matched so a refusal that arrives as a 400 still refreshes.
 */
function isAuthenticationFailure(status: number, body: unknown): boolean {
  return (
    status === 401 ||
    ((status === 400 || status === 200) &&
      errorCodes(body).includes("AUTHENTICATION_ERROR") &&
      !(body as { data?: unknown } | undefined)?.data)
  );
}

function graphqlResult(response: Response, body: unknown): LinearGraphqlResult {
  const status = response.status;
  const ratelimited = errorCodes(body).includes("RATELIMITED");
  if (status === 429 || status >= 500 || (status === 400 && ratelimited)) {
    const retryAfterSeconds = retryAfter(response);
    return {
      outcome: "transient",
      status,
      message:
        status === 429 || ratelimited
          ? "Linear rate limited the request"
          : `Linear answered ${String(status)}`,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
  if (status >= 400) {
    const first = graphqlErrors(body)?.[0]?.message;
    return {
      outcome: "permanent",
      status,
      message: first ? first.slice(0, 300) : `Linear answered ${String(status)}`,
    };
  }
  if (!body || typeof body !== "object") {
    return { outcome: "transient", status, message: "Linear answered without JSON" };
  }
  const errors = graphqlErrors(body);
  return {
    outcome: "ok",
    data: (body as { data?: unknown }).data ?? null,
    ...(errors?.length ? { errors } : {}),
  };
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? undefined
    : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

type TokenGrant =
  | {
      outcome: "granted";
      accessToken: string;
      refreshToken?: string;
      expiresIn?: number;
    }
  | { outcome: "rejected"; status: number }
  | {
      outcome: "transient";
      status?: number;
      message: string;
      retryAfterSeconds?: number;
    };

async function requestToken(form: Record<string, string>): Promise<TokenGrant> {
  const fetched = await linearFetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  if (fetched.kind === "network") {
    return { outcome: "transient", message: fetched.message };
  }
  const response = fetched.response;
  if (response.status === 429 || response.status >= 500) {
    const retryAfterSeconds = retryAfter(response);
    return {
      outcome: "transient",
      status: response.status,
      message: `Linear answered ${String(response.status)}`,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
  if (!response.ok) return { outcome: "rejected", status: response.status };
  const body = (await readJsonBody(response)) as
    | { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
    | undefined;
  if (!body || typeof body.access_token !== "string" || !body.access_token) {
    return {
      outcome: "transient",
      status: response.status,
      message: "Linear returned no access token",
    };
  }
  return {
    outcome: "granted",
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" && body.refresh_token
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body.expires_in === "number" && body.expires_in > 0
      ? { expiresIn: body.expires_in }
      : {}),
  };
}

/** `viewer` with an `actor=app` token is the app user; its organization is the workspace. */
async function readViewer(
  accessToken: string,
): Promise<{ appUserId: string; organizationId: string } | null> {
  const fetched = await linearFetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "query { viewer { id organization { id } } }" }),
  });
  if (fetched.kind === "network" || !fetched.response.ok) return null;
  const body = (await readJsonBody(fetched.response)) as
    | { data?: { viewer?: { id?: unknown; organization?: { id?: unknown } } } }
    | undefined;
  const viewer = body?.data?.viewer;
  return typeof viewer?.id === "string" &&
    viewer.id &&
    typeof viewer.organization?.id === "string" &&
    viewer.organization.id
    ? { appUserId: viewer.id, organizationId: viewer.organization.id }
    : null;
}

/** Best effort: true when Linear confirmed the revocation. */
async function revokeToken(accessToken: string): Promise<boolean> {
  const fetched = await linearFetch(LINEAR_REVOKE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      token: accessToken,
      token_type_hint: "access_token",
    }).toString(),
  });
  return fetched.kind === "response" && fetched.response.ok;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export function isLinearCredentialValue(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL_VALUE.test(value);
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < size; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function logLinear(
  level: "info" | "warn",
  event: string,
  connectionId: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, event, connectionId, ...fields });
  if (level === "warn") console.warn(line);
  else console.log(line);
}
