// Runs async jobs one after another, in the order they were queued (the
// runner's deliveries, which arrive concurrently: a later message must not
// overtake an earlier one). A job that hangs (a stuck interrupt or command)
// holds the queue at most `stuckMs` from its start; then the next job starts
// and the stuck one keeps running on its own. A job's result and failure go
// to its caller only; they never affect the jobs after it.

export class Ordered {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private stuckMs: number,
    private onStuck: () => void = () => {},
  ) {}

  run<T>(job: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const slot = new Promise<void>((r) => (release = r));
    const result = this.tail.then(() => {
      const timer = setTimeout(() => (this.onStuck(), release()), this.stuckMs);
      timer.unref?.();
      const p = Promise.resolve().then(job);
      void p.then(release, release).finally(() => clearTimeout(timer));
      return p;
    });
    this.tail = slot;
    return result;
  }
}
