// A message sent mid-turn reaches the model only at the next tool boundary
// (session.ts). A tool that blocks for minutes, such as `gh run watch` or a
// sleep loop, held it unseen while the thread showed nothing but 👀. When a
// message is still waiting behind a running step after HELD_STEER_MS, the
// thread says what it waits on and how to break in.

import { fmtDuration } from './format.js';

export const HELD_STEER_MS = 8_000;

export interface HeldSteerDeps {
  /** The step running longest; undefined when nothing runs (the model is writing, and reads it soon). */
  running(): { title: string; ms: number } | undefined;
  say(text: string): unknown;
}

export class HeldSteer {
  private timer?: NodeJS.Timeout;

  constructor(private deps: HeldSteerDeps, private ms = HELD_STEER_MS) {}

  /** A message joined the running turn: one notice per wait, however many messages join it. */
  arm() {
    this.timer ??= setTimeout(() => this.fire(), this.ms);
  }

  /** A tool result went back (and every waiting message with it), or the turn ended. */
  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fire() {
    const step = this.deps.running();
    if (!step) return void (this.timer = undefined);
    void this.deps.say(`Still in \`${step.title}\` (${fmtDuration(step.ms)}). I'll read your message when it finishes; start a message with \`!!\` to stop it now.`);
  }
}
