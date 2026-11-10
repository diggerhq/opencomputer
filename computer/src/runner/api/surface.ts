// Where a session renders (work 084): every call Session and its prompts make
// to show something to a person goes through a Surface. SlackSurface is
// today's SlackThread, unchanged, plus the factories for the live message
// (Segment), the folded history (History) and the subagents panel
// (AgentsPanel); NullSurface is a session with no Slack binding (created over
// the API), which renders nowhere and is read through its journal.
//
// Invariants:
// - SlackSurface adds no awaits and no calls: what Slack sees is exactly what
//   the session posted before the surface existed (runner/api/golden/, the
//   Slack golden, holds it to that byte for byte);
// - NullSurface never throws on a render and never reaches Slack. Its Segment,
//   History and AgentsPanel are real (the timeline keeps its card state in
//   them) and write into a client that answers every call and goes nowhere;
//   `upload` refuses, so send_file tells the model there is no thread.

import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import { AgentsPanel } from '../agents.js';
import type { Names } from '../names.js';
import { History, Segment, type Target } from '../segment.js';
import type { FileUpload } from '../send-file.js';
import { SlackThread, type SessionStatus } from '../thread.js';

/** What a session renders through. */
export interface Surface extends Names {
  /** Renders in Slack: reactions, names and the context bar mean something. */
  readonly slack: boolean;
  /** The Slack client; the runner replaces it when the bot token rotates. */
  client: WebClient;
  readonly target: Target;
  /** A new live message, streaming only once `after` settles. */
  segment(after: Promise<unknown>): Segment;
  history(): History;
  /** A subagents panel; `stop` stops one subagent. */
  panel(stop: (taskId: string) => Promise<void>): AgentsPanel;
  say(text: string): Promise<void>;
  post(text: string, blocks: KnownBlock[]): Promise<string>;
  update(ts: string, text: string, blocks: KnownBlock[], what?: string): Promise<void>;
  delete(ts: string, what?: string): Promise<void>;
  upload(f: FileUpload, before?: Promise<unknown>): Promise<void>;
  setStatus(status: SessionStatus): Promise<void>;
  rename(title: string): Promise<void>;
  showContext(s: { cwd: string; model?: string; mode: string; costUsd: number; ctxTokens: number }): Promise<void>;
  setDiffView(diff: string): Promise<void>;
  archive(): Promise<void>;
  intro(threadId: string): Promise<void>;
  userName(id: string): Promise<string>;
}

/** The Slack conversation a session renders into: SlackThread, and what streams into it. */
export class SlackSurface extends SlackThread implements Surface {
  readonly slack = true;

  segment(after: Promise<unknown>) {
    return new Segment(this.client, this.target, after);
  }

  history() {
    return new History(this.client, this.target);
  }

  panel(stop: (taskId: string) => Promise<void>) {
    return new AgentsPanel(this.client, this.target, stop);
  }
}

/** A client that answers every Web API call `ok` and sends nothing. */
export function nullClient(): WebClient {
  let n = 0;
  const node = (): unknown =>
    new Proxy(() => {}, {
      get: (_, k) => (k === 'then' ? undefined : node()),
      apply: async () => ({ ok: true, ts: `0.${++n}` }),
    });
  return node() as WebClient;
}

/** A session with no Slack binding: renders nowhere. */
export class NullSurface implements Surface {
  readonly slack = false;
  client = nullClient();
  readonly target: Target = { channel: '', recipientUserId: '' };

  segment(after: Promise<unknown>) {
    return new Segment(this.client, this.target, after);
  }
  history() {
    return new History(this.client, this.target);
  }
  panel(stop: (taskId: string) => Promise<void>) {
    return new AgentsPanel(this.client, this.target, stop);
  }
  async say() {}
  async post() {
    return '';
  }
  async update() {}
  async delete() {}
  async upload(): Promise<void> {
    throw new Error('this session has no Slack thread to post files to; tell the person where the file is instead');
  }
  async setStatus() {}
  async rename() {}
  async showContext() {}
  async setDiffView() {}
  async archive() {}
  async intro() {}
  async userName(id: string) {
    return id;
  }
  async nameOf() {
    return undefined;
  }
  async where() {
    return 'the API';
  }
}

/** A surface passed in, or a Slack client to render through as a session always did. */
export const isSurface = (x: WebClient | Surface): x is Surface => x instanceof SlackSurface || x instanceof NullSurface;
