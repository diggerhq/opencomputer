// Limits on checking Claude setup tokens through the warm pool
// (work 081, "Abuse"). Every pool computer leaves through
// one shared egress, with Claude Code's user agent: a run of stolen tokens
// tested from the dashboard would look to Anthropic like our fleet spraying
// 401s, and a block would hit every connected seat. So the `computer-pool`
// object, which every pool probe passes through, keeps:
//
// - fixed ten-minute windows per dashboard user (`user:<id>`, 5 probes) and
//   per token fingerprint (`fp:<fingerprint>`, 3 probes), counting only
//   probes that reached a pool computer (a refused attempt, an open breaker
//   or an empty pool charges nobody: nothing left our egress);
// - a circuit breaker: when more than 20 probes and more than half of all
//   probes in the current window were rejected, probing stops until the
//   window turns over (the token is stored unchecked meanwhile; nothing is
//   lost).
//
// One row per key in `probe_counts`; a row from an older window is
// overwritten in place by the next count, never cleaned up later. The
// fingerprint is the store's 12-hex sha256 prefix: never the token.

export const PROBE_WINDOW_MS = 10 * 60_000;
export const PROBES_PER_USER = 5;
export const PROBES_PER_TOKEN = 3;
/** The breaker opens above this many rejections in a window… */
export const BREAKER_MIN_REJECTIONS = 20;
/** …when they are also above this share of the window's probes. */
export const BREAKER_REJECTED_SHARE = 0.5;

const PROBES = "breaker:probes";
const REJECTED = "breaker:rejected";

export class ProbeLimits {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number,
  ) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS probe_counts (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        n INTEGER NOT NULL
      );
    `);
  }

  private window(): number {
    const now = this.now();
    return now - (now % PROBE_WINDOW_MS);
  }

  /** The key's count in the current window (0 when its row is from an older one). */
  count(key: string): number {
    const row = [...this.sql.exec<{ windowStart: number; n: number }>("SELECT window_start AS windowStart, n FROM probe_counts WHERE key = ?", key)][0];
    return row && row.windowStart === this.window() ? row.n : 0;
  }

  /** Adds one to the key's count in the current window, overwriting an older window's row; the new count. */
  bump(key: string): number {
    const window = this.window();
    this.sql.exec(
      `INSERT INTO probe_counts (key, window_start, n) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET n = CASE WHEN window_start = excluded.window_start THEN n + 1 ELSE 1 END, window_start = excluded.window_start`,
      key,
      window,
    );
    return this.count(key);
  }

  /**
   * A peek: whether the user and the token are both under their limits in
   * the current window. Charges nothing; `charge` does, once a probe is
   * really sent.
   */
  admit(userKey: string, fingerprint: string): boolean {
    return this.count(`user:${userKey}`) < PROBES_PER_USER && this.count(`fp:${fingerprint}`) < PROBES_PER_TOKEN;
  }

  /** A probe is going out for this user and token: one on each counter. */
  charge(userKey: string, fingerprint: string): void {
    this.bump(`user:${userKey}`);
    this.bump(`fp:${fingerprint}`);
  }

  /** Whether the breaker is open: too many of this window's probes were rejected. */
  breakerOpen(): boolean {
    const rejected = this.count(REJECTED);
    return rejected > BREAKER_MIN_REJECTIONS && rejected > this.count(PROBES) * BREAKER_REJECTED_SHARE;
  }

  /** A probe reached a pool computer and came back (`rejected`: Anthropic answered 401 or 403). */
  record(rejected: boolean): void {
    this.bump(PROBES);
    if (rejected) this.bump(REJECTED);
  }
}
