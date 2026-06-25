import type { Http, Query } from "./http.js";
import type { Event, Level, Limits, LastTurn, SessionData, SessionStatus, Turn } from "./types.js";
import { parseEventStream } from "./sse.js";
import { Destinations, Deliveries } from "./destinations.js";

export type Envelope = { text?: string; [k: string]: unknown };

export interface CreateSessionParams {
  agent: string;
  input: string | Envelope;
  /** get-or-create idempotency/routing key — one session per key. */
  key?: string;
  webhook?: string;
  /**
   * Inline webhook destinations. These can't carry a signing `secret` — to sign
   * deliveries, register the destination with `session.destinations.create({ secret })`.
   */
  destinations?: Array<{ url: string; level?: Level; types?: string[]; includeRaw?: boolean; enabled?: boolean }>;
  limits?: Limits;
  /**
   * Opaque application routing state stored on the session — a JSON object (≤ 16 KB).
   * Returned on `get`/`list` (as `session.metadata`) and delivered verbatim in
   * webhooks, so a callback handler can route to the right record without a lookup. It is
   * never shown to the model and not indexed/queryable. Distinct from `key`
   * (get-or-create) and `idempotencyKey` (dedupe).
   */
  metadata?: Record<string, unknown>;
  /** Makes a keyless create retry-safe (sent as the Idempotency-Key header). */
  idempotencyKey?: string;
  /**
   * Repositories to check out for the agent at the start of the session. Each source
   * is materialized into `/workspace/sources/<name>` before the agent's first turn;
   * the checkout credential never enters the agent's sandbox. See {@link Repos} and
   * the [Repos guide](https://docs.opencomputer.dev/agent-sessions/repos).
   *
   * Reference a registered repo (preferred — auth lives on the repo), or pass an
   * inline source with per-session auth (no registration).
   */
  sources?: SessionSource[];
}

/** A repo to check out for a session. Either a reference to a registered {@link Repo},
 *  or an inline source with its own per-session auth. */
export type SessionSource = RegisteredRepoSource | InlineRepoSource;

export interface RegisteredRepoSource {
  /** A registered repo id (`repo_…`) or `owner/repo` slug. Auth comes from the repo. */
  repo: string;
  /** Required fetch ref (branch or `refs/pull/N/head`). */
  ref: string;
  /** Required exact commit; fetched, then pinned + verified. */
  sha: string;
  /** Checkout slug → `/workspace/sources/<name>`. Defaults to the repo name. */
  name?: string;
}

export interface InlineRepoSource {
  /** Clone URL (https, no embedded credentials). */
  url: string;
  ref: string;
  sha: string;
  name?: string;
  /** Per-session auth (the registered-repo path carries auth on the repo instead). */
  auth: SourceAuth;
}

/** Per-source auth for the inline path. Prefer a registered repo + broker connection. */
export type SourceAuth =
  | { type: "token_broker"; brokerUrl: string; grant: string }
  | { type: "risky_short_lived_token"; token: string; expiresAt: string };

/** Sanitized per-source status returned on a session (never exposes url/auth). */
export interface SourceSummary {
  name: string;
  status: "pending" | "materializing" | "resolved" | "failed" | "unavailable" | "auth_required";
  path: string;
  sha: string;
}

export interface StreamOptions {
  /** Visibility threshold; default `internal` (the full build trace). */
  level?: Level;
  /** Filter by event type (exact or `prefix.*`). Applied client-side as the stream arrives. */
  type?: string;
  /** Resume from this seq (default 0 — replays the whole log). */
  after?: number;
  signal?: AbortSignal;
}

export interface ListPage<T> { data: T[]; nextCursor?: string | null; }

/** Sessions — durable runs of an agent. */
export class Sessions {
  constructor(private readonly http: Http) {}

  async create(params: CreateSessionParams): Promise<Session> {
    const { idempotencyKey, ...body } = params;
    const r = await this.http.request<{ session: SessionData; clientToken?: string; sources?: SourceSummary[] }>(
      "POST", "/sessions",
      { body, idempotencyKey, idempotent: Boolean(idempotencyKey || params.key) },
    );
    return new Session(this.http, r.session, r.clientToken, r.sources);
  }
  async get(id: string): Promise<Session> {
    return new Session(this.http, await this.http.request<SessionData>("GET", `/sessions/${id}`));
  }
  list(params: { agent?: string; status?: SessionStatus; key?: string; after?: string; before?: string; limit?: number; cursor?: string } = {}): Promise<ListPage<SessionData>> {
    return this.http.request("GET", "/sessions", { query: params as Query });
  }
}

/**
 * Read + steer surface for one session. Works with a session **client token** (browser-safe,
 * `read`+`steer` scopes) or an org key, and is what `connectSession` returns. For management
 * (lifecycle, destinations, deliveries, minting tokens) use the full {@link Session} returned
 * by `sessions.create`/`get` with the org key.
 */
export class ClientSession {
  constructor(protected readonly http: Http, readonly id: string, readonly clientToken?: string) {}

  /**
   * Stream events as an async iterator. Reconnects from the last seq on a dropped
   * connection and keeps tailing until the `signal` aborts. Replays the log from `after`
   * (default 0) on first connect.
   */
  async *events(opts: StreamOptions = {}): AsyncGenerator<Event> {
    let after = opts.after ?? 0;
    const base: Query = { stream: "sse", level: opts.level ?? "internal", type: opts.type };
    for (;;) {
      if (opts.signal?.aborted) return;
      let res: Response;
      try {
        res = await this.http.stream(`/sessions/${this.id}/events`, { ...base, after }, opts.signal);
      } catch (e) {
        if (opts.signal?.aborted) return;
        throw e; // auth/404/etc. — surface it
      }
      try {
        for await (const ev of parseEventStream(res)) {
          after = ev.seq;   // advance the cursor on every event, even filtered-out ones
          // The SSE endpoint streams by level+seq; apply the type filter here (exact or `prefix.*`).
          if (opts.type && !(opts.type.endsWith(".*") ? ev.type.startsWith(opts.type.slice(0, -1)) : ev.type === opts.type)) continue;
          yield ev;
        }
      } catch {
        if (opts.signal?.aborted) return;
        // network drop mid-stream — fall through and reconnect from `after`
      }
      if (opts.signal?.aborted) return;
      await sleep(1000); // stream ended (caught up / closed) — pause before re-tailing
    }
  }

  /** Read a page of events without streaming. */
  listEvents(opts: { after?: number; level?: Level; type?: string; turnId?: string; limit?: number } = {}): Promise<ListPage<Event>> {
    return this.http.request("GET", `/sessions/${this.id}/events`, { query: opts as Query });
  }

  /** Fetch a single event by id. */
  event(eventId: string): Promise<Event> {
    return this.http.request("GET", `/sessions/${this.id}/events/${eventId}`);
  }

  /** Fetch a blob-backed event body (large outputs) as text. */
  async eventContent(eventId: string): Promise<string> {
    return (await this.http.raw("GET", `/sessions/${this.id}/events/${eventId}/content`)).text();
  }

  /** User-message history (alias for level=user + type=*.message). */
  messages(opts: { after?: number; limit?: number } = {}): Promise<ListPage<Event>> {
    return this.http.request("GET", `/sessions/${this.id}/messages`, { query: opts as Query });
  }

  /** Send a message; wakes the session. */
  async steer(text: string, opts: { idempotencyKey?: string } = {}): Promise<{ id: string; seq: number }> {
    const r = await this.http.request<{ event: { id: string; seq: number } }>(
      "POST", `/sessions/${this.id}/messages`,
      { body: { text, idempotencyKey: opts.idempotencyKey }, idempotent: Boolean(opts.idempotencyKey) },
    );
    return r.event;
  }
}

/**
 * Full handle to one session — everything in {@link ClientSession} plus management
 * (lifecycle, destinations, deliveries, client tokens). Needs the **org key**; returned by
 * `sessions.create`/`get`.
 */
export class Session extends ClientSession {
  /** Webhook destinations + delivery records for this session (org key). */
  readonly destinations: Destinations;
  readonly deliveries: Deliveries;
  private data: SessionData;
  private _sources: SourceSummary[];

  constructor(http: Http, data: SessionData, clientToken?: string, sources?: SourceSummary[]) {
    super(http, data.id, clientToken);
    this.data = data;
    this._sources = sources ?? [];
    this.destinations = new Destinations(http, data.id);
    this.deliveries = new Deliveries(http, data.id);
  }

  get status(): SessionStatus { return this.data.status; }
  get lastTurn(): LastTurn | undefined { return this.data.lastTurn; }
  /** Source checkout status from create — `{ name, status, path, sha }[]` (empty when none).
   *  For live status after create, poll `GET /sessions/:id/sources`. */
  get sources(): SourceSummary[] { return this._sources; }
  /** Opaque app routing state set at create (`null` when unset). See {@link CreateSessionParams.metadata}. */
  get metadata(): Record<string, unknown> | null { return this.data.metadata ?? null; }
  /** The latest fetched session record. */
  get snapshot(): SessionData { return this.data; }

  async refresh(): Promise<this> {
    this.data = await this.http.request<SessionData>("GET", `/sessions/${this.id}`);
    return this;
  }

  /** Per-turn history (timing + outcome), paginated. */
  turns(opts: { after?: string; limit?: number } = {}): Promise<ListPage<Turn>> {
    return this.http.request("GET", `/sessions/${this.id}/turns`, { query: opts as Query });
  }
  turn(turnId: string): Promise<Turn> {
    return this.http.request("GET", `/sessions/${this.id}/turns/${turnId}`);
  }

  /** The resolved final result + last-turn summary. */
  result(): Promise<{ lastTurn?: LastTurn | null; result?: Event | null }> {
    return this.http.request("GET", `/sessions/${this.id}/result`);
  }
  cancel(): Promise<void> { return this.http.request("POST", `/sessions/${this.id}/cancel`); }
  archive(): Promise<void> { return this.http.request("POST", `/sessions/${this.id}/archive`); }

  /** Mint a browser-safe client token for this session (org key only). */
  async mintClientToken(opts: { scopes?: Array<"read" | "steer">; ttlSeconds?: number } = {}): Promise<string> {
    const r = await this.http.request<{ clientToken?: string; token?: string }>(
      "POST", `/sessions/${this.id}/client-tokens`,
      { body: { scopes: opts.scopes, ttl: opts.ttlSeconds } },
    );
    return (r.clientToken ?? r.token)!;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
