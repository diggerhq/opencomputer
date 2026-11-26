// A bounded queue between the app-server's stdout and the session's pump:
// records are pushed as lines are read and taken as the session consumes
// them. Past `high` queued records it asks its producer to pause (the child's
// stdout stops being read, so the pipe fills and Codex blocks on its own
// writes); at `low` it asks it to resume.
//
// Invariants:
// - every pushed record is yielded once, in order, before the end;
// - `end` is final: a failure ends the iteration with it after the records
//   already queued, and pushes after the end are dropped;
// - pause and resume alternate, starting with pause.

export class Mailbox<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private wake?: () => void;
  private done?: { error?: unknown };
  private paused = false;

  constructor(
    private flow: { pause(): void; resume(): void },
    private high = 1000,
    private low = 100,
  ) {}

  get ended() {
    return !!this.done;
  }

  push(...xs: T[]) {
    if (this.done || !xs.length) return;
    this.buf.push(...xs);
    if (!this.paused && this.buf.length >= this.high) (this.paused = true), this.flow.pause();
    this.wake?.();
  }

  /** No more records: the iteration ends after the queued ones, failing with `error` when given. */
  end(error?: unknown) {
    if (this.done) return;
    this.done = { error };
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.buf.length) {
        const x = this.buf.shift()!;
        if (this.paused && this.buf.length <= this.low) (this.paused = false), this.flow.resume();
        yield x;
      }
      if (this.done) {
        if (this.done.error !== undefined) throw this.done.error;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}
