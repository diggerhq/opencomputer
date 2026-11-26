// Subagents, like Claude Code's agents panel: one Slack message listing every
// subagent the session started, updated in place. It is a plain message, not
// part of the turn's stream, because background agents outlive the turn that
// launched them; their events keep arriving after it ends.
//
// A row per agent: status, name, type, what it is doing now (the harness's
// progress description or, with Claude's agentProgressSummaries, a
// model-written line), tool calls, tokens, elapsed. Stop while it runs; Result once done
// opens its final answer in a modal.

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { randomUUID } from 'node:crypto';
import { fmtDuration, fmtTokens } from './format.js';
import type { TaskRecord } from './harness/types.js';
import type { Target } from './segment.js';
import { log } from '../log.js';

type Status = 'running' | 'completed' | 'failed' | 'stopped';
interface Agent {
  id: string;
  name: string;
  type?: string;
  background: boolean;
  status: Status;
  start: number;
  end?: number;
  doing?: string;
  tools: number;
  tokens: number;
  result?: string;
  stopping?: boolean;
}

/** Panels waiting on their buttons, by panel id (action ids are `a:<panel>:<verb>:<task>`). */
export const panels = new Map<string, AgentsPanel>();

const ICON: Record<Status, string> = { running: '⏳', completed: '✅', failed: '❌', stopped: '⏹' };
const RENDER_MS = 2500;
const TICK_MS = 5000;

export class AgentsPanel {
  readonly id = randomUUID().slice(0, 8);
  ts?: string;
  private agents = new Map<string, Agent>();
  private timer?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private client: WebClient,
    private target: Target,
    private stop: (taskId: string) => Promise<void>,
  ) {
    panels.set(this.id, this);
  }

  get running() {
    return [...this.agents.values()].some((a) => a.status === 'running');
  }

  has(taskId: string) {
    return this.agents.has(taskId);
  }

  /** Feeds one subagent record; false when it is about an agent this panel doesn't hold. */
  onEvent(e: TaskRecord): boolean {
    if (e.state === 'started') {
      this.agents.set(e.id, {
        id: e.id,
        name: e.title || 'Agent',
        type: e.agentType,
        background: !!e.background,
        status: 'running',
        start: Date.now(),
        tools: 0,
        tokens: 0,
      });
      this.render(true);
      this.ticker ??= setInterval(() => this.running ? this.render() : this.stopTicker(), TICK_MS);
      return true;
    }
    const a = this.agents.get(e.id);
    if (!a) return false;
    if (e.background) a.background = true;
    if (e.error) a.result ??= e.error;
    if (e.state === 'progress') {
      a.doing = e.doing || a.doing;
      a.tools = e.tools ?? a.tools;
      a.tokens = e.tokens ?? a.tokens;
      this.render();
      return true;
    }
    this.finish(a, e.state === 'done' ? 'completed' : e.state);
    // A stopped agent's summary is just its description again.
    if (e.result && e.result !== a.name) a.result = e.result;
    if (e.durationMs !== undefined) {
      a.tools = e.tools ?? a.tools;
      a.tokens = e.tokens ?? a.tokens;
      a.end = a.start + e.durationMs;
    }
    this.render(true);
    return true;
  }

  async onAction(verb: string, taskId: string, triggerId: string) {
    const a = this.agents.get(taskId);
    if (!a) return;
    if (verb === 'stop' && a.status === 'running' && !a.stopping) {
      a.stopping = true;
      this.render(true);
      await this.stop(taskId).catch((e) => log.warn('stopTask', e?.message ?? e));
    }
    if (verb === 'result') await this.openResult(a, triggerId);
  }

  private finish(a: Agent, s: Status) {
    if (a.status !== 'running') return;
    a.status = s;
    a.end ??= Date.now();
    a.doing = undefined;
  }

  private stopTicker() {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private render(now = false) {
    if (now) clearTimeout(this.timer), (this.timer = undefined);
    else if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.chain = this.chain.then(() => this.send()).catch((e) => log.warn('agents panel', e?.data?.error ?? e?.message ?? e));
    }, now ? 0 : RENDER_MS);
  }

  private async send() {
    const blocks = this.blocks();
    const text = this.headline();
    if (!this.ts) {
      const r = await this.client.chat.postMessage({
        channel: this.target.channel,
        ...(this.target.threadTs ? { thread_ts: this.target.threadTs } : {}),
        text,
        blocks,
      });
      this.ts = r.ts;
    } else await this.client.chat.update({ channel: this.target.channel, ts: this.ts, text, blocks });
  }

  private headline() {
    const all = [...this.agents.values()];
    const by = (s: Status) => all.filter((a) => a.status === s).length;
    return [
      `${all.length} subagent${all.length === 1 ? '' : 's'}`,
      by('running') && `${by('running')} running`,
      by('completed') && `${by('completed')} done`,
      by('failed') && `${by('failed')} failed`,
      by('stopped') && `${by('stopped')} stopped`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  private blocks(): KnownBlock[] {
    const rows = [...this.agents.values()].slice(-45).map((a): KnownBlock => {
      const meta = [a.type, a.background ? 'background' : undefined].filter(Boolean).join(' · ');
      const stats = [
        a.tools ? `${a.tools} tool${a.tools === 1 ? '' : 's'}` : undefined,
        a.tokens ? `${fmtTokens(a.tokens)} tok` : undefined,
        fmtDuration((a.end ?? Date.now()) - a.start),
      ].filter(Boolean);
      const line =
        a.status === 'running'
          ? [a.stopping ? 'stopping…' : a.doing, ...stats].filter(Boolean).join(' · ')
          : [preview(a.result), ...stats].filter(Boolean).join(' · ');
      const button =
        a.status === 'running'
          ? a.stopping
            ? undefined
            : { text: 'Stop', verb: 'stop', style: 'danger' as const }
          : a.result
            ? { text: 'Result', verb: 'result' }
            : undefined;
      return {
        type: 'section',
        text: { type: 'mrkdwn', text: clip(`${ICON[a.status]} *${esc(a.name)}*${meta ? `  _${esc(meta)}_` : ''}\n${esc(line)}`, 2900) },
        ...(button
          ? {
              accessory: {
                type: 'button',
                text: { type: 'plain_text', text: button.text },
                action_id: `a:${this.id}:${button.verb}:${a.id}`,
                ...(button.style ? { style: button.style } : {}),
              },
            }
          : {}),
      };
    });
    return [{ type: 'context', elements: [{ type: 'mrkdwn', text: `*Subagents* · ${this.headline()}` }] }, ...rows];
  }

  private async openResult(a: Agent, triggerId: string) {
    const text = a.result ?? '(no result)';
    const view = (blocks: KnownBlock[]) => ({
      type: 'modal' as const,
      title: { type: 'plain_text' as const, text: clip(a.name, 24) },
      close: { type: 'plain_text' as const, text: 'Close' },
      blocks: [
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${ICON[a.status]} ${a.status}${a.type ? ` · ${a.type}` : ''}` }] } as KnownBlock,
        ...blocks,
      ],
    });
    try {
      await this.client.views.open({ trigger_id: triggerId, view: view([{ type: 'markdown', text: clip(text, 11900) } as KnownBlock]) });
    } catch (e: any) {
      // Fall back to plain mrkdwn sections where a markdown block isn't accepted.
      log.warn('result modal (markdown):', e?.data?.error ?? e?.message);
      const parts = (clip(text, 2900 * 20) ?? '').match(/[\s\S]{1,2900}/g) ?? [];
      await this.client.views
        .open({ trigger_id: triggerId, view: view(parts.map((p) => ({ type: 'section', text: { type: 'mrkdwn', text: p } }))) })
        .catch((e2: any) => log.warn('result modal:', e2?.data?.error ?? e2?.message));
    }
  }

  dispose() {
    this.stopTicker();
    panels.delete(this.id);
  }
}

function clip(s: string, n: number): string;
function clip(s: string | undefined, n: number): string | undefined;
function clip(s: string | undefined, n: number) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : s;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** First line of a result, for the row. */
const preview = (s?: string) => clip(s?.replace(/[*_`#>]/g, '').split('\n').find((l) => l.trim())?.trim(), 140);
