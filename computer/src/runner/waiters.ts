// Requests the runner makes through its host (spawn_thread, read_thread,
// post_thread, previews, checkout_repo, request_secret): each sends a frame
// with a fresh id and waits for the answer that carries the same id.
//
// Invariants: a request made with no host connected fails at once, unsent; a
// waiter is removed when it is answered or times out, so it settles exactly
// once and a late answer finds nothing.

import { randomUUID } from 'node:crypto';

export class Waiters<F, M> {
  private waiting = new Map<string, (m: M) => void>();

  constructor(
    private o: {
      /** Sends the frame; false when no host is connected to send it to. */
      send: (frame: F) => boolean;
      ms: number;
      /** The error after `ms` without an answer. */
      late: string;
    },
  ) {}

  /** Sends `frame(id)`; resolves with what `settle` makes of the answer (it throws to reject). */
  ask<T>(frame: (id: string) => F, settle: (m: M) => T): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      if (!this.o.send(frame(id))) return reject(new Error('host not connected'));
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(this.o.late));
      }, this.o.ms);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        try {
          resolve(settle(m));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** The answer for `id`; none waiting (timed out, or never asked): dropped. */
  answer(id: string, m: M) {
    this.waiting.get(id)?.(m);
  }

  /** Every waiting request gets `m` (the host went away: their answers never come). */
  answerAll(m: M) {
    for (const w of [...this.waiting.values()]) w(m);
  }
}
