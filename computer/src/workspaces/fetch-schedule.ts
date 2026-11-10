// When a fork may use a clone's already-fetched refs, and how fetches are
// scheduled on a host (work 045: "forks use already-fetched refs, no network").
//
// Invariants:
// - A clone's origin refs are fresh while a fetch that *started* after the
//   last push notification for that clone succeeded less than the freshness
//   window ago. A push that lands while a fetch runs therefore never counts as
//   fetched, and a clone never fetched by this process is never fresh.
// - Fetches of one clone run one at a time in their own lane, apart from the
//   clone's worktree lock (workspaces/index.ts `serial`): a fork's worktree add
//   never waits behind a housekeeping fetch, and a fork that needs a fetch
//   joins the lane and re-checks freshness when its turn comes.
// - `limit(n)` bounds how many housekeeping fetches run at once on the host;
//   urgent ones (after a push) wait ahead of the rest.

/** Freshness of each clone's origin refs, from fetch starts and push notifications. */
export class Freshness {
  private fetched = new Map<string, number>();
  private pushed = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}

  /** A fetch of `clone` that started at `startedAt` succeeded. */
  fetchedFrom(clone: string, startedAt: number) {
    if (startedAt > (this.fetched.get(clone) ?? Number.NEGATIVE_INFINITY)) this.fetched.set(clone, startedAt);
  }

  /** A push notification for the branch `clone` forks from arrived now. */
  pushedNow(clone: string) {
    this.pushed.set(clone, this.now());
  }

  /** Whether a fork may skip its fetch of `clone`. */
  fresh(clone: string, windowMs: number): boolean {
    const f = this.fetched.get(clone);
    if (f === undefined) return false;
    const p = this.pushed.get(clone);
    if (p !== undefined && f <= p) return false;
    return this.now() - f < windowMs;
  }
}

/** One queue per key: functions for the same key run one at a time, in call order. */
export function keyedQueue() {
  const queues = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => queues.get(key) === tail && queues.delete(key));
    return run;
  };
}

/** At most `n` of the functions given run at once; the rest wait in order, urgent ones first. */
export function limit(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  let urgentWaiting = 0;
  return async <T>(fn: () => Promise<T>, urgent = false): Promise<T> => {
    if (active >= n)
      await new Promise<void>((r) => (urgent ? waiting.splice(urgentWaiting++, 0, () => (urgentWaiting--, r())) : waiting.push(r)));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else active--;
    }
  };
}
