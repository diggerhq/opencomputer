// What the Work index needs of the platform it runs on. index.ts, item.ts and github.ts use only
// these, so they hold no platform; index-do.ts adapts a Durable Object to them, and the tests a
// node:sqlite database and a hand-moved clock (test/work-index.test.ts).

export type StoreValue = string | number | null;

/** SQLite: statements and one synchronous transaction at a time. */
export interface IndexStore {
  /** Runs `sql` (several statements when there are no parameters); a SELECT's rows, else []. */
  exec<T extends Record<string, StoreValue> = Record<string, StoreValue>>(sql: string, ...params: StoreValue[]): T[];
  /** Runs `fn` as one transaction: all of its writes or none. */
  transaction<T>(fn: () => T): T;
}

export interface Clock {
  /** ms epoch. */
  now(): number;
  /** Calls `fn` once after `ms`; the returned function cancels it. */
  timeout(ms: number, fn: () => void): () => void;
}

export interface Scheduler {
  /** Makes sure the alarm fires at `at` or sooner. */
  arm(at: number): Promise<void>;
  /** Keeps the host alive until `promise` settles. */
  waitUntil(promise: Promise<unknown>): void;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** `promise`, or `onTimeout()` when it has not settled after `ms`. */
export function within<T>(clock: Clock, ms: number, promise: Promise<T>, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = clock.timeout(ms, () => resolve(onTimeout()));
    promise.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
  });
}
