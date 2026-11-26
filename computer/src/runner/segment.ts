// A Segment is one bot message in Slack that grows while the agent works.
//
// Native mode uses Slack's streaming API (chat.startStream / appendStream /
// stopStream): text deltas become markdown_text chunks, tool calls become
// task_update chunks that flip in place from in_progress to complete. Pending
// chunks are coalesced and flushed on a timer so we stay under appendStream's
// rate limit while still feeling live.
//
// A task_update replaces a card's title and status but *appends* its details
// and output. So while a card is live everything that changes (details, timer,
// output summary) rides in the title; details and output are sent once the
// card is final, and later only as an extension of what was already sent.
//
// Slack ends a stream about 10 minutes after it starts. A real change after
// that continues in a new message; a timer tick alone does not, or a long wait
// (an unanswered question) would post a new message every 10 minutes.
//
// Edit mode is the fallback when streaming is unavailable: the whole segment
// is re-rendered as one markdown block and chat.update'd. A startStream
// refused for this message alone (a turn sent over the API, with no Slack
// message behind it) falls back for this message only; only a refusal that
// holds for every message (plan, scopes) turns streaming off for the runner.

import type { WebClient } from '@slack/web-api';
import type { AnyChunk, KnownBlock } from '@slack/types';
import { log } from '../log.js';
import { placeholderWrites, queuedSince } from './surface-meter.js';

export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';
export interface Task {
  id: string;
  /** Tool name (Bash, Read, …), for compact summaries; not rendered. */
  name?: string;
  title: string;
  status: TaskStatus;
  details?: string;
  elapsed?: string;
  output?: string;
  /** Settled for good (a closed run): details and output can be sent. */
  final?: boolean;
  /** Waiting on the person (an open prompt): its timer stands still. Not rendered. */
  waiting?: boolean;
  /** The turn's opening `Started` card (timeline.ts), not a step. Not rendered. */
  opening?: boolean;
  /** Still running when the turn ended. Not rendered. */
  interrupted?: boolean;
}

export interface Target {
  channel: string;
  threadTs?: string; // undefined = top-level (code channel)
  recipientUserId: string;
  recipientTeamId?: string;
}

export type Item = { kind: 'text'; text: string } | { kind: 'task'; task: Task };
/** Queued for the next flush; task chunks are built at flush time from the card's latest state. */
type Pending = { type: 'markdown_text'; text: string } | { type: 'task'; id: string };

const NATIVE_FLUSH_MS = Number(process.env.FLUSH_MS ?? 600);
const EDIT_FLUSH_MS = 1200;
const ROTATE_AT_CHARS = 9000;
/**
 * Past this a message rotates even mid-markdown. Edit mode renders the last
 * 11,500 chars (Slack's markdown block holds 12,000), so this leaves room for
 * one large emit to land before the rotation without clipping the top.
 */
const ROTATE_HARD_CHARS = 10000;

let nativeStreaming = process.env.STREAMING !== 'off';
/** startStream errors that hold for every message of this workspace and token, not just this one. */
const STREAMING_UNAVAILABLE = new Set(['missing_scope', 'not_allowed_token_type', 'unknown_method', 'feature_not_enabled', 'paid_only', 'paid_teams_only']);

const clip = (s: string | undefined, n: number) =>
  s && s.length > n ? s.slice(0, n - 1) + '…' : s;

export class Segment {
  ts?: string;
  size = 0;
  private items: Item[] = [];
  private pending: Pending[] = [];
  /** Per card, the details/output this message already shows (Slack appends them). */
  private sent = new Map<string, { details: string; output: string }>();
  /** Pending cards with a change beyond their timer. */
  private real = new Set<string>();
  /** Slack ended the stream; a new one opens only for a real change. */
  private ended = false;
  private timer?: NodeJS.Timeout;
  /** Native writes keep their cadence across idle gaps; only one timed flush may wait on Slack. */
  private lastFlush?: number;
  private flushing = false;
  private chain: Promise<unknown>;
  private closed = false;
  private started = false;
  private mode: 'native' | 'edit' = nativeStreaming ? 'native' : 'edit';
  /** When the oldest change not yet written was made (`performance.now()`); a timer tick is not a change. Telemetry only. */
  private since?: number;

  /** `after`: nothing is posted before it settles (a session's intro, which must read above this message). */
  constructor(
    private client: WebClient,
    private target: Target,
    after?: Promise<unknown>,
  ) {
    this.chain = after ? after.catch(() => {}) : Promise.resolve();
  }

  get empty() {
    return this.items.length === 0;
  }

  text(delta: string) {
    if (!delta || this.closed) return;
    const last = this.items.at(-1);
    if (last?.kind === 'text') last.text += delta;
    else this.items.push({ kind: 'text', text: delta });
    const lp = this.pending.at(-1);
    if (lp?.type === 'markdown_text') lp.text += delta;
    else this.pending.push({ type: 'markdown_text', text: delta });
    this.size += delta.length;
    this.since ??= performance.now();
    this.schedule();
  }

  /** Tasks still running in this message (so a rotation can mark them as moved). */
  openTasks(): Task[] {
    return this.items.flatMap((i) => (i.kind === 'task' && i.task.status === 'in_progress' ? [i.task] : []));
  }

  endsWithText() {
    return this.items.at(-1)?.kind === 'text';
  }

  /**
   * Big enough that output should continue in a new message, at a point where
   * the cut can't break markdown: splitting a code fence or a link leaves both
   * halves as raw text.
   */
  get full() {
    if (this.size > ROTATE_HARD_CHARS) return true;
    const last = this.items.at(-1);
    return this.size > ROTATE_AT_CHARS && (last?.kind !== 'text' || atBreak(last.text));
  }

  /** Cards that are steps: an opening card that ended as `✓ Started` is not one. */
  get cards() {
    return this.items.filter((i) => i.kind === 'task' && !isOpened(i.task)).length;
  }

  view(): readonly Item[] {
    return this.items;
  }

  /** `tick`: only the card's timer changed. */
  task(t: Task, opts: { tick?: boolean } = {}) {
    if (this.closed) return;
    if (!opts.tick) (this.real.add(t.id), (this.since ??= performance.now()));
    const item = this.items.find(
      (i): i is { kind: 'task'; task: Task } => i.kind === 'task' && i.task.id === t.id,
    );
    // A card is updated many times (rolling runs, timers); count its current size once.
    this.size += taskSize(t) - (item ? taskSize(item.task) : 0);
    if (item) item.task = { ...t };
    else this.items.push({ kind: 'task', task: { ...t } });
    if (!this.pending.some((c) => c.type === 'task' && c.id === t.id)) this.pending.push({ type: 'task', id: t.id });
    this.schedule();
    // The opening card goes out at once and so does the first real thing after it, not a flush interval later.
    if (t.opening && t.status === 'in_progress') this.started = false;
  }

  /**
   * Flush everything, finalize the message, optionally attach blocks (status
   * footer). A streaming message ends in one call: what is still pending goes
   * with chat.stopStream; if that fails, it is appended (or a new stream
   * opened) and the stream stopped as before. True when chat.stopStream
   * succeeded, so `sessionStatus` is set too.
   */
  async close(opts: { blocks?: KnownBlock[]; sessionStatus?: string | (() => string | undefined) } = {}): Promise<boolean> {
    if (this.closed) return this.chain.then(() => false);
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const stopped = await this.enqueue(async () => {
      if (this.mode === 'native' && !this.ts) await this.flush(); // opens the stream with what is pending
      if (this.mode === 'edit') return void (await this.renderEdit(opts.blocks));
      if (!this.ts) return void (opts.blocks && (await this.post(opts.blocks)));
      // Decided when the stream stops: a turn that began meanwhile keeps its working status.
      const status = typeof opts.sessionStatus === 'function' ? opts.sessionStatus() : opts.sessionStatus;
      const stop = (chunks: AnyChunk[]) => {
        const args = this.stamp({
          channel: this.target.channel,
          ts: this.ts!,
          ...(chunks.length ? { chunks } : {}),
          ...(opts.blocks ? { blocks: opts.blocks } : {}),
          ...(status ? { session_status: status } : {}),
        });
        return this.client.chat.stopStream(args).catch((e) => (this.unstamp(args), Promise.reject(e)));
      };
      const sent = new Map(this.sent);
      const { queued, real, chunks } = this.take();
      try {
        return !!(await stop(chunks));
      } catch (e) {
        if (!chunks.length) throw e;
        log.warn('stopStream with chunks failed, appending them first:', slackError(e));
        this.sent = sent;
        for (const id of real) this.real.add(id);
        this.pending = [...queued, ...this.pending];
      }
      await this.flush();
      return !!this.ts && !!(await stop([]));
    });
    return stopped === true;
  }

  /** Finalize without a footer and remove the message, if one was posted (a silent turn). */
  async discard() {
    await this.close();
    if (this.ts)
      await this.client.chat
        .delete({ channel: this.target.channel, ts: this.ts })
        .catch((e) => log.warn('delete silent turn', e?.data?.error ?? e?.message));
  }

  private schedule() {
    if (this.timer || this.closed || this.flushing) return;
    const elapsed = this.lastFlush === undefined ? 0 : performance.now() - this.lastFlush;
    const delay = !this.started ? 0 : this.mode === 'native' ? Math.max(0, NATIVE_FLUSH_MS - elapsed) : EDIT_FLUSH_MS;
    this.started = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushing = true;
      void this.enqueue(async () => {
        this.lastFlush = performance.now();
        try {
          await this.flush();
        } finally {
          this.flushing = false;
          if (this.pending.length) this.schedule();
        }
      });
    }, delay);
  }

  /** Mark a write's arguments with the age of the content it carries (surface-meter.ts); the content is then no longer waiting. */
  private stamp<T extends object>(args: T): T {
    if (this.since !== undefined) queuedSince.set(args, this.since);
    this.since = undefined;
    return args;
  }

  /** A write failed and its content is pending again: it has been waiting since `args` was stamped, or earlier. */
  private unstamp(args: object) {
    const s = queuedSince.get(args);
    if (s !== undefined) this.since = Math.min(s, this.since ?? s);
  }

  private enqueue(fn: () => Promise<unknown>) {
    this.chain = this.chain.then(fn).catch((e) => log.error('segment', e?.data ?? e));
    return this.chain;
  }

  /** The pending chunks, built now from each card's latest state. */
  private take() {
    if (this.ended) this.pending = this.pending.filter((c) => c.type !== 'task' || this.real.has(c.id));
    const queued = this.pending;
    this.pending = [];
    const real = queued.flatMap((c) => (c.type === 'task' && this.real.delete(c.id) ? [c.id] : []));
    return { queued, real, chunks: queued.flatMap((c): AnyChunk[] => (c.type === 'task' ? this.taskChunk(c.id) : [c])) };
  }

  private async flush(): Promise<void> {
    if (this.mode === 'edit') return this.renderEdit();
    const { queued, real, chunks } = this.take();
    if (!queued.length) return;
    const t = this.target;
    if (!this.ts) {
      // thread_ts is typed as required; omitting it streams a top-level
      // message, which Slack allows in code channels.
      const args = {
        channel: t.channel,
        ...((t.threadTs ? { thread_ts: t.threadTs } : {}) as { thread_ts: string }),
        recipient_user_id: t.recipientUserId,
        ...(t.recipientTeamId ? { recipient_team_id: t.recipientTeamId } : {}),
        task_display_mode: 'timeline',
        chunks,
      };
      // Telemetry tells the opening card apart from the first real content (surface-meter.ts).
      if (queued.every((c) => c.type === 'task' && this.isOpening(c.id))) placeholderWrites.add(args);
      try {
        const r = await this.client.chat.startStream(this.stamp(args));
        this.ts = r.ts;
        this.ended = false;
      } catch (e: any) {
        this.unstamp(args);
        const permanent = STREAMING_UNAVAILABLE.has(e?.data?.error);
        log.warn(`startStream failed, falling back to edit mode${permanent ? '' : ' for this message'}:`, e?.data?.error ?? e?.message);
        if (permanent) nativeStreaming = false;
        this.mode = 'edit';
        return this.renderEdit();
      }
      return;
    }
    const args = this.stamp({ channel: t.channel, ts: this.ts, chunks });
    try {
      await this.client.chat.appendStream(args);
    } catch (e: any) {
      this.unstamp(args);
      // Typically the stream was closed on Slack's side. What was appended
      // before stays in that message; continue in a new one with only the
      // chunks that didn't land (replaying everything duplicated the turn).
      // Cards in them start fresh in the new message.
      log.warn('appendStream failed, reopening stream:', e?.data?.error ?? e?.message);
      this.ts = undefined;
      this.sent.clear();
      this.ended = slackError(e) === 'message_not_in_streaming_state';
      for (const id of real) this.real.add(id);
      this.pending = [...queued, ...this.pending];
      return this.flush();
    }
  }

  private isOpening(id: string) {
    return this.items.some((i) => i.kind === 'task' && i.task.id === id && i.task.opening && i.task.status === 'in_progress');
  }

  private taskChunk(id: string): AnyChunk[] {
    const item = this.items.find((i): i is { kind: 'task'; task: Task } => i.kind === 'task' && i.task.id === id);
    if (!item) return [];
    const t = item.task;
    const line = (s?: string) => s?.replace(/\s+/g, ' ').trim();
    if (!t.final) {
      const title = [t.title, t.details, t.elapsed, line(t.output)].filter(Boolean).join(' · ');
      return [{ type: 'task_update', id, title: clip(title, 250)!, status: t.status }];
    }
    const prev = this.sent.get(id) ?? { details: '', output: '' };
    const details = clip(t.details, 250) ?? '';
    const output = clip(t.output, 250) ?? '';
    // Only extend what is shown; a changed text can't be taken back.
    const more = (was: string, now: string) => (now.startsWith(was) ? now.slice(was.length) : '');
    const dd = more(prev.details, details);
    const od = more(prev.output, output);
    this.sent.set(id, { details: prev.details + dd, output: prev.output + od });
    return [{
      type: 'task_update',
      id,
      title: clip(t.title, 250)!,
      status: t.status,
      ...(dd ? { details: dd } : {}),
      ...(od ? { output: od } : {}),
    }];
  }

  // ---- edit-mode fallback ----

  /** `placeholder`: it shows only the opening card (telemetry, surface-meter.ts). */
  private async post(blocks: KnownBlock[], placeholder = false) {
    const args = { channel: this.target.channel, ...(this.target.threadTs ? { thread_ts: this.target.threadTs } : {}), text: ' ', blocks };
    if (placeholder) placeholderWrites.add(args);
    const r = await this.client.chat.postMessage(this.stamp(args));
    this.ts = r.ts;
  }

  private async renderEdit(extra: KnownBlock[] = []) {
    const md = renderMarkdown(this.items).slice(-11500);
    if (!md && !extra.length) return;
    const blocks = [...(md ? [{ type: 'markdown', text: md } as KnownBlock] : []), ...extra];
    const placeholder = !extra.length && this.items.every((i) => i.kind === 'task' && this.isOpening(i.task.id));
    if (!this.ts) return this.post(blocks, placeholder);
    await this.client.chat.update(this.stamp({ channel: this.target.channel, ts: this.ts, text: ' ', blocks }));
  }
}

/**
 * The text ends at a line break and outside a code fence, so a message can end
 * here. Fences open with three or more backticks or tildes and close with at
 * least as many of the same character (CommonMark), so a ```` block may quote
 * ``` lines without closing.
 */
export function atBreak(text: string): boolean {
  if (!text.endsWith('\n')) return false;
  let open: { ch: string; n: number } | undefined;
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const ch = m[1][0];
    const n = m[1].length;
    if (!open) open = { ch, n };
    else if (ch === open.ch && n >= open.n) open = undefined;
  }
  return !open;
}

const slackError = (e: unknown) => (e as { data?: { error?: string }; message?: string })?.data?.error ?? (e as Error)?.message;

/** The opening card that ended as `✓ Started` (text came first): no step happened. */
const isOpened = (t: Task) => !!t.opening && t.status === 'complete';

const taskSize = (t: Task) => t.title.length + (t.details?.length ?? 0) + (t.output?.length ?? 0);

const ICON: Record<TaskStatus, string> = {
  pending: '◻️',
  in_progress: '⏳',
  complete: '✅',
  error: '❌',
};

function renderMarkdown(items: Item[]): string {
  return items
    .map((i) => {
      if (i.kind === 'text') return i.text.trim();
      const t = i.task;
      let s = `${ICON[t.status]} \`${t.title}\``;
      const d = [t.details, t.elapsed].filter(Boolean).join(' · ');
      if (d) s += `  _${d}_`;
      if (t.output) s += '\n```\n' + clip(t.output, 400) + '\n```';
      return s;
    })
    .filter(Boolean)
    .join('\n\n');
}

const HISTORY_CHARS = 1200;
const HISTORY_LINES = 6;

/**
 * Earlier messages of a long turn, folded into one compact grey block. The
 * first folded message is edited into the history; later ones are deleted and
 * their lines appended, so a turn reads as: history, then a short live message.
 */
export class History {
  private ts?: string;
  private lines: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private client: WebClient,
    private target: Target,
  ) {}

  fold(seg: Segment) {
    this.lines.push(...summarize(seg.view()));
    const closing = seg.close();
    this.chain = this.chain
      .then(async () => {
        await closing;
        if (!seg.ts) return;
        if (!this.ts) this.ts = seg.ts;
        else await this.client.chat.delete({ channel: this.target.channel, ts: seg.ts });
        await this.client.chat.update({ channel: this.target.channel, ts: this.ts, text: ' ', blocks: this.blocks() });
      })
      .catch((e) => log.error('history', e?.data ?? e));
  }

  private blocks(): KnownBlock[] {
    const kept: string[] = [];
    let len = 0;
    for (let i = this.lines.length - 1; i >= 0 && kept.length < HISTORY_LINES; i--) {
      if (len + this.lines[i].length + 1 > HISTORY_CHARS) break;
      kept.unshift(this.lines[i]);
      len += this.lines[i].length + 1;
    }
    const dropped = this.lines.length - kept.length;
    if (dropped) kept.unshift(`_… ${dropped} earlier_`);
    return [{ type: 'context', elements: [{ type: 'mrkdwn', text: kept.join('\n') }] }];
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * One line per narration with a count of the steps that followed it:
 * `text · 3 steps`. Step titles stay out; the narration says what happened,
 * and commands are noise once the turn has moved on.
 */
export function summarize(items: readonly Item[]): string[] {
  const lines: string[] = [];
  let steps = 0;
  let failed = 0;
  const flush = () => {
    if (!steps) return;
    const tag = `${steps} step${steps > 1 ? 's' : ''}${failed ? ` (${failed} failed)` : ''}`;
    if (lines.length) lines[lines.length - 1] += ` · ${tag}`;
    else lines.push(tag);
    steps = failed = 0;
  };
  for (const i of items) {
    if (i.kind === 'text') {
      const t = i.text.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      flush();
      lines.push(esc(clip(t, 160)!));
      continue;
    }
    const t = i.task;
    if (isOpened(t)) continue;
    // A closed multi-step run is "Ran N steps · K failed".
    const m = /^Ran (\d+) steps(?: · (\d+) failed)?/.exec(t.title);
    steps += m ? Number(m[1]) : 1;
    failed += m ? Number(m[2] ?? 0) : t.status === 'error' || t.title.endsWith(' · failed') ? 1 : 0;
  }
  flush();
  return lines;
}
