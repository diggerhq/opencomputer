// The Slack conversation a session renders into: a thread, or the top level
// of a code channel. Every Slack Web API call a session makes outside its live
// Segment goes through here, so `thread_ts` is decided in one place, failures
// are logged once per method and error code, and a fake client covers all of
// it. The client is replaceable: the runner swaps it when the bot token rotates.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { log } from '../log.js';
import type { Target } from './segment.js';
import type { FileUpload } from './send-file.js';
import { describeChannel, type Names } from './names.js';
import { gitBranch } from '../workspace.js';
import { fmtTokens } from './format.js';

/** A name lookup never holds a message longer than this; the id stands in (p90 is ~240 ms). */
const LOOKUP_MS = 800;
const MISS_TTL_MS = 10 * 60_000;
const within = async <T>(call: () => Promise<T>): Promise<T | undefined> =>
  Promise.race([call(), new Promise<undefined>((r) => setTimeout(r, LOOKUP_MS))]);

/** What the thread reads about its conversation; the session's info object, read live. */
export interface ThreadInfo {
  kind: 'thread' | 'channel';
  channel: string;
  threadTs?: string;
  userId: string;
  teamId?: string;
  title: string;
}

export type SessionStatus = 'processing' | 'active' | 'suspended' | 'closed';

export interface ContextBarItem {
  key: string;
  label: string;
  icon: string;
}

export class SlackThread implements Names {
  private warned = new Set<string>();
  private static names = new Map<string, { name?: string; at: number }>();
  private channelName?: string;

  constructor(
    public client: WebClient,
    private info: ThreadInfo,
  ) {}

  /** Where a Segment or panel streams: the thread, or top level in a code channel. */
  get target(): Target {
    return {
      channel: this.info.channel,
      threadTs: this.info.kind === 'thread' ? this.info.threadTs : undefined,
      recipientUserId: this.info.userId,
      recipientTeamId: this.info.teamId,
    };
  }

  /** `thread_ts` for chat.* calls; absent at the top level of a code channel. */
  private get thread() {
    const ts = this.target.threadTs;
    return ts ? { thread_ts: ts } : {};
  }

  /** A plain message; a failure is logged, never thrown. */
  async say(text: string) {
    await this.client.chat.postMessage({ channel: this.info.channel, ...this.thread, text }).catch((e) => this.warn('say', e));
  }

  /** A message with blocks; returns its ts. Throws when Slack refuses, for callers that need the message. */
  async post(text: string, blocks: KnownBlock[]): Promise<string> {
    const r = await this.client.chat.postMessage({ channel: this.info.channel, ...this.thread, text, blocks });
    return r.ts!;
  }

  async update(ts: string, text: string, blocks: KnownBlock[], what = 'update') {
    await this.client.chat.update({ channel: this.info.channel, ts, text, blocks }).catch((e) => this.warn(what, e));
  }

  async delete(ts: string, what = 'delete') {
    await this.client.chat.delete({ channel: this.info.channel, ts }).catch((e) => this.warn(what, e));
  }

  /**
   * send_file: upload into the conversation. Throws, so the tool can report why
   * to the model. The bytes go up while `before` (the previous message closing)
   * settles; the file is shared into the thread only after it, so it lands below.
   * uploadV2's three steps, unrolled for that overlap.
   */
  async upload(f: FileUpload, before?: Promise<unknown>) {
    const data = await readFile(f.path);
    const { upload_url, file_id } = await this.client.files.getUploadURLExternal({
      filename: f.filename,
      length: data.length,
      ...(f.altText ? { alt_text: f.altText } : {}),
    });
    if (!upload_url || !file_id) throw new Error('no upload url');
    await this.postBytes(upload_url, data);
    await before;
    await this.client.files.completeUploadExternal({
      files: [{ id: file_id, title: f.title ?? f.filename }],
      channel_id: this.info.channel,
      ...this.thread,
      ...(f.comment ? { initial_comment: f.comment } : {}),
    } as any);
  }

  /**
   * The bytes to Slack's upload URL (raw body, as Slack's own SDKs send it).
   * uploadV2 ran this through the SDK's retrying client; here: a time bound
   * that scales with the size, and one retry on a network error or a 5xx.
   */
  private async postBytes(url: string, data: Buffer) {
    const ms = 30_000 + Math.ceil(data.length / 100); // ~100 KB/s floor: 10 MB gets 130 s; AbortSignal.timeout takes integers only
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url, { method: 'POST', body: new Uint8Array(data), signal: AbortSignal.timeout(ms) });
        if (r.ok) return;
        if (r.status < 500 || attempt) throw new Error(`upload failed: HTTP ${r.status}`);
      } catch (e) {
        if (attempt) throw e;
      }
    }
  }

  /** The agent session status Slack shows (`is thinking…`, the stop button). */
  async setStatus(status: SessionStatus) {
    await this.client.agents.sessions
      .setStatus({
        channel_id: this.info.channel,
        status,
        ...this.thread,
        title: this.info.title.slice(0, 200),
        initiator_user_id: this.info.userId,
      })
      .catch((e) => this.warn('agents.sessions.setStatus', e));
  }

  /** The session's name in Slack's agent sessions list; a thread's only (a code channel's name is its channel's). */
  async rename(title: string) {
    if (this.info.kind !== 'thread') return;
    await this.client.agents.sessions
      .rename({ channel_id: this.info.channel, ...this.thread, title: title.slice(0, 200) })
      .catch((e) => this.warn('agents.sessions.rename', e));
  }

  /** A code channel's context bar from the session's state: folder, branch, model, mode, cost and context. */
  async showContext(s: { cwd: string; model?: string; mode: string; costUsd: number; ctxTokens: number }) {
    const branch = await gitBranch(s.cwd);
    await this.setContextBar([
      { key: 'cwd', label: path.basename(s.cwd), icon: 'folder' },
      ...(branch ? [{ key: 'branch', label: branch, icon: 'branch' }] : []),
      { key: 'model', label: (s.model ?? 'default').replace(/^claude-/, ''), icon: 'code' },
      // Bypass is the default and not something users need to see; other modes change behavior, so they show.
      ...(s.mode !== 'bypassPermissions' ? [{ key: 'mode', label: s.mode, icon: 'terminal' }] : []),
      { key: 'cost', label: `$${s.costUsd.toFixed(2)} · ctx ${fmtTokens(s.ctxTokens)}`, icon: 'hierarchy' },
    ]);
  }

  /** A code channel's context bar. */
  async setContextBar(items: ContextBarItem[]) {
    await this.client.agents.conversations
      .setProperties({ channel_id: this.info.channel, code_channel: { context_bar_items: items } })
      .catch((e) => this.warn('agents.conversations.setProperties', e));
  }

  /** A code channel's diff tab. */
  /**
   * A brand-new session's first reply: the thread id to copy (later a link to
   * the thread's page) and where the commands are.
   */
  async intro(threadId: string) {
    await this.post(`Thread ${threadId}`, [
      { type: 'context', elements: [{ type: 'mrkdwn', text: `:thread: Thread \`${threadId}\`  ·  \`!help\` for commands` }] },
    ]).catch((e) => this.warn('intro', e));
  }

  async setDiffView(diff: string) {
    await this.client.agents.conversations
      .setView({ channel_id: this.info.channel, type: 'diff', content: diff.slice(0, 990_000) })
      .catch((e) => this.warn('agents.conversations.setView', e));
  }

  /** `!done`: archive the code channel. */
  async archive() {
    await this.client.agents.conversations.archive({ channel_id: this.info.channel }).catch((e) => this.warn('archive', e));
  }

  /** A person's display name, or the id when Slack can't say. */
  async userName(id: string) {
    return (await this.nameOf(id)) ?? id;
  }

  /** A person's display name (falling back to real name), cached for the process; misses for ten minutes. */
  async nameOf(id: string): Promise<string | undefined> {
    const c = SlackThread.names.get(id);
    if (c && (c.name || Date.now() - c.at < MISS_TTL_MS)) return c.name;
    const r = await within(() => this.client.users.info({ user: id })).catch((e) => this.warn('users.info', e));
    const u = r?.user;
    const name = u?.profile?.display_name || u?.real_name || u?.name || undefined;
    // A timeout or error is tried again next message; only Slack's answer is cached.
    if (r) SlackThread.names.set(id, { name, at: Date.now() });
    return name;
  }

  /** The conversation by name (`#eng`, `a DM`), looked up once per session; a failure is retried next time. */
  async where(): Promise<string> {
    if (this.channelName) return this.channelName;
    const id = this.info.channel;
    const r = await within(() => this.client.conversations.info({ channel: id })).catch((e) => this.warn('conversations.info', e));
    if (r?.channel) this.channelName = describeChannel(id, r.channel);
    return this.channelName ?? describeChannel(id);
  }

  /** Log each failing Slack method once with its error code; the prototype keeps going. */
  warn(what: string, e: any) {
    const code = e?.data?.error ?? e?.message ?? String(e);
    const k = `${what}:${code}`;
    if (this.warned.has(k)) return;
    this.warned.add(k);
    log.warn(`${what} failed: ${code}`, e?.data?.response_metadata ?? '');
  }
}
