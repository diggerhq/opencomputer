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
  /** Makes a keyless create retry-safe (sent as the Idempotency-Key header). */
  idempotencyKey?: string;
}

export interface StreamOptions {
  /** Visibility threshold; default `internal` (the full build trace). */
  level?: Level;
  /** Filter by event type (exact or `prefix.*`). */
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
    const r = await this.http.request<{ session: SessionData; clientToken?: string }>(
      "POST", "/sessions",
      { body, idempotencyKey, idempotent: Boolean(idempotencyKey || params.key) },
    );
    return new Session(this.http, r.session, r.clientToken);
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
          after = ev.seq;
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

  constructor(http: Http, data: SessionData, clientToken?: string) {
    super(http, data.id, clientToken);
    this.data = data;
    this.destinations = new Destinations(http, data.id);
    this.deliveries = new Deliveries(http, data.id);
  }

  get status(): SessionStatus { return this.data.status; }
  get lastTurn(): LastTurn | undefined { return this.data.lastTurn; }
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
