// What the parts of the client share: the options, the clock, ordered writes to storage, one way to
// make a request and one way to wait before trying again.

import { Refused, type ClientFrame, type ClientOptions } from "./types.js";

export type Op = { put: string; value: unknown } | { delete: string };

export interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface Backoff {
  /** Resolves after the next delay (1 s doubling to 60 s, with jitter), or at once when the client comes online or closes. */
  wait(): Promise<void>;
  reset(): void;
}

export interface Ctx {
  o: ClientOptions;
  clientId: string;
  closed: boolean;
  now(): number;
  random(): number;
  /** Answers a function that cancels it. */
  timer(fn: () => void, ms: number): () => void;
  sleep(ms: number): Promise<void>;
  /** Ends every `sleep` now. */
  wake(): void;
  backoff(): Backoff;
  /** Writes are applied in the order they were asked for. */
  write(ops: Op[]): void;
  written(): Promise<void>;
  /** Rejects when the network does; an HTTP error is a reply. */
  request(path: string, init?: RequestInit): Promise<Reply>;
  /** To the socket in use, if there is one. */
  send(frame: ClientFrame): void;
}

export function createCtx(o: ClientOptions): Ctx {
  const set = o.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = o.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const sleepers = new Set<() => void>();
  let chain: Promise<void> = Promise.resolve();

  const ctx: Ctx = {
    o,
    clientId: "",
    closed: false,
    now: o.now ?? (() => Date.now()),
    random: o.random ?? Math.random,
    timer(fn, ms) {
      const h = set(fn, ms);
      return () => clear(h);
    },
    sleep(ms) {
      if (ctx.closed) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          cancel();
          sleepers.delete(done);
          resolve();
        };
        const cancel = ctx.timer(done, ms);
        sleepers.add(done);
      });
    },
    wake() {
      for (const done of [...sleepers]) done();
    },
    backoff() {
      let attempt = 0;
      return {
        reset: () => void (attempt = 0),
        wait: () => ctx.sleep(Math.min(60_000, 1000 * 2 ** attempt++) * (0.5 + ctx.random() / 2)),
      };
    },
    write(ops) {
      if (!ops.length) return;
      const s = o.storage;
      chain = chain
        .then(async () => {
          if (s.batch) return s.batch(ops);
          for (const op of ops) await ("put" in op ? s.put(op.put, op.value) : s.delete(op.delete));
        })
        .catch(() => {});
    },
    written: () => chain,
    async request(path, init) {
      const res = await o.fetch(path, init);
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // no body, or not JSON
      }
      return { status: res.status, body };
    },
    send() {},
  };
  return ctx;
}

/** 429 and 5xx: try again later. */
export function transient(status: number): boolean {
  return status === 429 || status >= 500;
}

export function refusal(r: Reply): Refused {
  const e = r.body?.error;
  if (typeof e === "string") return new Refused(e, r.body.reason ?? "", r.body);
  return new Refused(e?.code ?? `http_${r.status}`, e?.reason ?? e?.message ?? "", e);
}
