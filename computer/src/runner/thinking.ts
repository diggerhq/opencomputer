// "Thinking…" cards: a model thinking block shows as a card in the live
// message once it has lasted long enough to matter, its notes rolling in the
// card, and ends as "Thought for Ns". A block that ends before its card is due
// never shows. While a turn addressed to the agent shows nothing yet, the
// card is due sooner: it is the first sign the message was taken up; and when
// the turn's message is already open on its `Started` card (timeline.ts), the
// card shows at once, its notes streaming from the first delta. Keyed by the
// block's id (harness/types.ts: unique among the blocks open at once, which
// for Claude is the content-block index, per model call): Session clears it
// at the end of a turn. Each card shown is reported (telemetry: when the
// turn became renderable).

import { randomUUID } from 'node:crypto';
import type { Task } from './segment.js';
import { tail } from './timeline.js';

/** A thinking block shows its card after this long (telemetry's `turns` pipe assumes the same for older runners). */
export const THINKING_CARD_MS = 1500;
/** …or this soon, when it would be the first thing a turn addressed to the agent shows. */
export const FIRST_THINKING_CARD_MS = 300;
/** …or at once, when it takes over the turn's open `Started` card. */
export const OPENING_THINKING_CARD_MS = 0;

/** Where the cards go: the session's timeline. */
export interface TaskSink {
  setTask(t: Task): void;
  patchTask(id: string, patch: Partial<Task>): void;
}

interface Block {
  started: number;
  timer?: NodeJS.Timeout;
  id: string;
  notes: string;
}

export class ThinkingCards {
  private blocks = new Map<string, Block>();

  constructor(
    private sink: TaskSink,
    private shown: () => void = () => {},
  ) {}

  /** Thinking block `key` started; its card shows after `delay` ms if it is still going (0: now). */
  start(key: string, delay = THINKING_CARD_MS) {
    const b: Block = { started: Date.now(), id: `think-${randomUUID().slice(0, 8)}`, notes: '' };
    const show = () => {
      b.timer = undefined;
      this.sink.setTask({ id: b.id, title: 'Thinking…', status: 'in_progress', details: tail(b.notes) });
      this.shown();
    };
    this.blocks.set(key, b);
    if (delay <= 0) show();
    else b.timer = setTimeout(show, delay);
  }

  delta(key: string, text: string) {
    const b = this.blocks.get(key);
    if (!b) return;
    b.notes += text;
    if (!b.timer) this.sink.patchTask(b.id, { details: tail(b.notes) });
  }

  stop(key: string) {
    const b = this.blocks.get(key);
    if (!b) return;
    this.blocks.delete(key);
    if (b.timer) return clearTimeout(b.timer);
    const secs = Math.max(1, Math.round((Date.now() - b.started) / 1000));
    this.sink.patchTask(b.id, { title: `Thought for ${secs}s`, status: 'complete', details: tail(b.notes) });
  }

  /** The turn ended: cards not yet shown never will be. */
  clear() {
    for (const b of this.blocks.values()) clearTimeout(b.timer);
    this.blocks.clear();
  }
}
