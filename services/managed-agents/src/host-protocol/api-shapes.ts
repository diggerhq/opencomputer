// The public API's shapes as the host protocol carries them: actors, errors, journals, deltas.

// ---------------------------------------------------------------- v4 (work 084)
// Mirrors calvin src/protocol-api.ts (gateway ⇄ host part). Bodies (`params`, `result`,
// `event.data`) are the public API's shapes (api-types.ts); here they are opaque.

/** Who acted (API `Actor`). */
export interface CalvinApiActor {
  id: string;
  name: string | null;
  /** `slack | opc | dashboard | api | system`; open. */
  via: string;
  client: string | null;
}

/** An API error body as the writer returns it: `code` from errors.mdx, `status` its HTTP status. */
export interface CalvinApiError {
  code: string;
  message: string;
  status: number;
  retryable?: boolean;
  [field: string]: unknown;
}

/** A journal on the host's disk, in `hello.journals`: its file epoch and local last seq. */
export interface CalvinJournalReport {
  sessionId: string;
  /** 0: events with no epoch line yet (an adoption into a new file, torn before its commit record). */
  epoch: number;
  lastSeq: number;
  /** The epoch's first seq (calvin b9de827); blue compares `lastSeq` with the log's ack instead. */
  startSeq?: number;
}

/** One journal event in the public envelope (API `Event`). */
export interface CalvinJournalEvent {
  id: string;
  seq: number;
  createdAt: string;
  sessionId: string;
  turnId: string | null;
  type: string;
  actor: CalvinApiActor | null;
  data: unknown;
}

/** A delta as the host sends it (`C/protocol-api.ts`'s `HostDelta`). */
export interface CalvinDelta {
  type: string;
  sessionId?: string;
  turnId: string | null;
  data: unknown;
  offset: number;
  whole?: boolean;
}
