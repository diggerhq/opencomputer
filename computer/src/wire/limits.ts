// The relay's limits (work 084, "The frames"; opc docs reference/limits.mdx and
// websocket/flow-control.mdx), in one place, and the token bucket that meters
// requests and terminal input.
//
// Invariants: every number a client can observe is here and matches the docs;
// the bucket never goes negative and never holds more than its burst.

const MIB = 1024 * 1024;

export const LIMITS = {
  /** Sessions attached per connection (`too_many_attached`). */
  maxAttached: 20,
  /** A WebSocket message, either way; a larger one from the client closes with 1009. */
  maxMessageBytes: MIB,
  /** Requests per connection per second, and the burst (`rate_limited`). */
  maxRequestsPerSecond: 100,
  requestBurst: 100,
  /** Connections per member, across the relay (4029). */
  maxConnectionsPerMember: 50,
  /** Unsent bytes on one connection before it is closed with 4008. */
  maxUnsentBytes: 16 * MIB,
  /** A session's live backlog on one connection before it alone is detached (`too_far_behind`). */
  backlogBytes: 8 * MIB,
  backlogEvents: 10_000,
  /** Terminals open in one session, across connections (`too_many_terminals`). */
  terminalsPerSession: 8,
  /** Terminal input per terminal, bytes per second (and the burst). */
  terminalInputBytesPerSecond: MIB,
  /** A terminal data frame from the server, bytes including its 4-byte channel header. */
  terminalFrameBytes: 64 * 1024,
  /** Server pings; two missed close with 1001. */
  pingMs: 30_000,
  /** How long an attach to an id the computer does not know yet waits for its create. */
  holdUnknownMs: 2_000,
  /** A session's events wait at most this long for the response of a write in flight. */
  holdWriteMs: 2_000,
  /** How long a moved session's attachment keeps trying to reach its new writer before it is detached. */
  rewireMs: 15_000,
  /** Bytes handed to the socket and not yet flushed before the outbox stops sending. */
  socketHighWater: 256 * 1024,
  /** Bytes queued for one session before its writer's socket is paused (replay is paced by the reader). */
  sessionQueuePauseBytes: MIB,
  /** A merged delta stops growing here; later text starts a new entry. */
  mergedDeltaBytes: 256 * 1024,
  /** Most call-only writer links a connection keeps for sessions it is not attached to. */
  callLinks: 20,
  /** Uploads and downloads: unpacked bytes and entries (`too_large`). */
  filesBytes: 1024 * MIB,
  filesCount: 100_000,
  /** One file read with `workspace/file`. */
  fileBytes: 100 * MIB,
} as const;

/** A token bucket: `take(n)` returns 0 when allowed, else the ms until `n` tokens are there. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.at = now;
  }

  take(n = 1, now = Date.now()): number {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) * this.perSecond) / 1000);
    this.at = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return 0;
    }
    return Math.max(1, Math.ceil(((n - this.tokens) * 1000) / this.perSecond));
  }
}
