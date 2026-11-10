// The end of a turn's message (final flush, footer and chat.stopStream, or a
// silent turn's delete), run off the session's pump (work 068 2f) so the next
// turn's events never wait for Slack.
//
// Invariants: closes run one after another, so the messages and their
// `turn.closed` facts keep turn order; `idle` fires only once every close has
// landed and no turn runs, never while a footer is still in flight; and a close that lands
// while a later turn runs never leaves the session looking idle (its
// `processing` status is put back).

import { log } from '../log.js';
import type { Segment } from './segment.js';
import type { SessionStatus } from './thread.js';

export interface CloseHooks {
  /** A turn is running now (one may begin while an earlier one closes). */
  busy(): boolean;
  setStatus(status: SessionStatus): Promise<unknown>;
  /** One close landed (turn-events' `closed`). */
  closed(): void;
  /** Every close so far has landed and no turn runs. */
  idle(): void;
}

export class TurnCloser {
  private last: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private h: CloseHooks) {}

  /** Settles once every close queued so far has landed; a new message posts after it. */
  get settled(): Promise<void> {
    return this.last;
  }

  /** A silent turn: what made it out (a card) goes away; no footer. */
  discard(seg?: Segment) {
    this.run(async () => {
      if (seg && !seg.empty) await seg.discard();
      await this.status(false);
    });
  }

  /** The footer ends the message; chat.stopStream sets the status with it, unless a turn began meanwhile. `then`: once it landed. */
  finish(seg: Segment, footer: string, then?: () => void) {
    this.run(async () => {
      const blocks = [{ type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text: footer }] }];
      await this.status(await seg.close({ blocks, sessionStatus: () => (this.h.busy() ? undefined : 'active') }));
      then?.();
    });
  }

  /** `set`: chat.stopStream carried a status. Otherwise (no stream, edit mode, a failure, silent) it is set here. */
  private async status(set: boolean) {
    if (!set && !this.h.busy()) await this.h.setStatus('active');
    // A turn that began while this closed keeps its working status, whatever landed last.
    if (this.h.busy()) await this.h.setStatus('processing');
  }

  private run(close: () => Promise<unknown>) {
    this.pending++;
    this.last = this.last
      .then(close)
      .catch((e) => log.error('turn close', e))
      .then(() => {
        this.h.closed();
        // A turn that began meanwhile reports idle itself when it ends.
        if (--this.pending === 0 && !this.h.busy()) this.h.idle();
      });
  }
}
