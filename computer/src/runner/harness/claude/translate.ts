// Claude Code's SDK messages → the seam's records (../types.ts). The only
// reader of the SDK's message shapes besides the fork compaction's own loop
// (shadow.ts), so the rest of the runner sees one vocabulary for any harness.
//
// Invariants:
// - a subagent's stream and tool results stay inside the harness; its tool
//   calls and messages arrive with `parent`, its lifecycle as `task` records;
// - a message's text is shown from its deltas; one that never streamed (some
//   SDK failures arrive only as a final assistant message) arrives as a whole
//   `text` record, unless it is a refusal for credits, which is a `limit`.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { resultText } from '../../format.js';
import type { BlockKind, HarnessEvent, TaskRecord, Usage } from '../types.js';

interface Fields {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  status?: unknown;
  parent_tool_use_id?: string | null;
  error?: string;
  event?: {
    type?: string;
    index?: number;
    message?: { usage?: RawUsage };
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  };
  message?: { content?: unknown };
  compact_metadata?: { trigger?: string; pre_tokens?: number; duration_ms?: number };
  usage?: RawUsage;
  duration_api_ms?: number;
  total_cost_usd?: number;
}
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };

const usage = (u: RawUsage = {}): Usage => ({
  input: u.input_tokens ?? 0,
  output: u.output_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
});

function kindOf(type?: string): BlockKind {
  if (type === 'tool_use' || type === 'server_tool_use') return 'tool';
  if (type === 'thinking' || type === 'redacted_thinking') return 'thinking';
  return type === 'text' ? 'text' : 'other';
}

/**
 * The model provider refused a main-turn call for credits: the SDK's
 * `billing_error`, or the 402 it renders as text (OpenRouter refuses a call
 * its key's remaining limit can't cover).
 */
export function isOutOfCredits(m: SDKMessage): boolean {
  if (m.type !== 'assistant' || m.parent_tool_use_id) return false;
  if (m.error === 'billing_error') return true;
  const content = m.message?.content;
  return Array.isArray(content) && (content as Array<{ type: string; text?: string }>).some((b) => b.type === 'text' && /^API Error: 402\b/m.test(b.text ?? ''));
}

/** The main thread's model was refused for this seat (not a subagent's: those name their own model). */
export function isModelDenied(m: SDKMessage): boolean {
  return m.type === 'assistant' && !m.parent_tool_use_id && m.error === 'model_not_found';
}

/** One harness's translator: it remembers which blocks are open and whether the current message streamed. */
export class Translator {
  /** The open blocks of the current message, by index; text and thinking gather their deltas. */
  private blocks = new Map<number, { kind: BlockKind; id: string; text: string }>();
  /** The current message streamed some text. */
  private streamed = false;
  /** Records a hook produced (hooks.ts), out with the next message so the stream keeps its order. */
  private held: HarnessEvent[] = [];

  /** The PostCompact hook: the compaction's summary is written, `chars` long. */
  summarized(chars: number) {
    this.held.push({ t: 'compaction', phase: 'summary', summaryChars: chars });
  }

  /**
   * Drop what hooks reported and no message has carried out yet: a fork's
   * compaction summary belongs to the fork's own loop (shadow.ts), not to the
   * session that adopts it.
   */
  dropHeld() {
    this.held = [];
  }

  translate(m: SDKMessage): HarnessEvent[] {
    if (!this.held.length) return this.message(m);
    const held = this.held;
    this.held = [];
    return [...held, ...this.message(m)];
  }

  private message(m: SDKMessage): HarnessEvent[] {
    const e = m as unknown as Fields;
    switch (e.type) {
      case 'system':
        return this.system(e);
      case 'stream_event':
        return e.parent_tool_use_id ? [] : this.stream(e.event ?? {});
      case 'assistant':
        return this.assistant(m, e);
      case 'user':
        return e.parent_tool_use_id ? [] : results(e.message?.content);
      case 'result':
        return [
          {
            t: 'turn_ended',
            // `error_during_execution` is a stopped turn or a failed one: Session and TurnEvents know which.
            reason: e.subtype === 'success' ? 'done' : 'error',
            ...(e.subtype !== 'success' ? { detail: e.subtype } : {}),
            usage: usage(e.usage),
            ...(e.duration_api_ms !== undefined ? { apiMs: e.duration_api_ms } : {}),
            ...(e.total_cost_usd !== undefined ? { costTotalUsd: e.total_cost_usd } : {}),
          },
        ];
    }
    return [];
  }

  private system(e: Fields): HarnessEvent[] {
    if (e.subtype === 'init') return [{ t: 'session', ref: { harness: 'claude', id: e.session_id ?? '' }, model: e.model ?? '' }];
    if (e.subtype === 'status') {
      if (e.status === 'requesting') return [{ t: 'request', phase: 'start' }];
      if (e.status === 'compacting') return [{ t: 'compaction', phase: 'start' }];
      return [];
    }
    if (e.subtype === 'compact_boundary') {
      const c = e.compact_metadata ?? {};
      return [{ t: 'compaction', phase: 'end', trigger: c.trigger, before: c.pre_tokens, durationMs: c.duration_ms }];
    }
    const task = taskOf(e as unknown as Record<string, any>);
    return task ? [task] : [];
  }

  private stream(ev: NonNullable<Fields['event']>): HarnessEvent[] {
    const index = ev.index ?? -1;
    switch (ev.type) {
      case 'message_start':
        this.blocks.clear();
        this.streamed = false;
        return [{ t: 'request', phase: 'first_token', usage: usage(ev.message?.usage) }];
      case 'message_stop':
        return [{ t: 'request', phase: 'end' }];
      case 'content_block_start': {
        const b = ev.content_block ?? {};
        const kind = kindOf(b.type);
        // A tool call's block is the call's id; any other is its index, unique within the message. A tool block
        // without an id (never seen from the API) falls back to its index too: unique still, only not the call's.
        const id = (kind === 'tool' && b.id) || String(index);
        this.blocks.set(index, { kind, id, text: '' });
        return [{ t: 'block', phase: 'start', id, index, kind, ...(kind === 'tool' ? { name: b.name } : {}) }];
      }
      case 'content_block_delta': {
        const d = ev.delta ?? {};
        const block = this.blocks.get(index);
        if (d.type === 'text_delta') {
          if (d.text) this.streamed = true;
          if (block) block.text += d.text ?? '';
          return [{ t: 'live', kind: 'text', id: String(index), delta: d.text ?? '' }];
        }
        if (d.type === 'input_json_delta' && d.partial_json && block?.kind === 'tool') return [{ t: 'tool_input', id: block.id, delta: d.partial_json }];
        if (d.type === 'thinking_delta' && d.thinking) {
          if (block) block.text += d.thinking;
          return [{ t: 'live', kind: 'thinking', id: String(index), delta: d.thinking }];
        }
        return [];
      }
      case 'content_block_stop': {
        const block = this.blocks.get(index);
        this.blocks.delete(index);
        const kind = block?.kind ?? 'other';
        const end: HarnessEvent = { t: 'block', phase: 'end', id: block?.id ?? String(index), index, kind };
        return kind === 'text' || kind === 'thinking' ? [end, { t: kind, delta: block!.text }] : [end];
      }
    }
    return [];
  }

  private assistant(m: SDKMessage, e: Fields): HarnessEvent[] {
    const parent = e.parent_tool_use_id ?? undefined;
    const content = (Array.isArray(e.message?.content) ? e.message.content : []) as Block[];
    const out: HarnessEvent[] = [{ t: 'message', ...(parent ? { parent } : {}) }];
    const credits = isOutOfCredits(m);
    if (credits) out.push({ t: 'limit', kind: 'credits' });
    if (isModelDenied(m)) out.push({ t: 'error', kind: 'model', code: 'model_not_found', message: textOf(content) });
    if (!parent && !this.streamed && !credits) {
      const text = textOf(content);
      if (text) out.push({ t: 'text', delta: text });
    }
    for (const b of content) if (b.type === 'tool_use' && b.id && b.name) out.push({ t: 'tool', id: b.id, name: b.name, input: b.input, ...(parent ? { parent } : {}) });
    return out;
  }
}

const textOf = (content: Block[]) =>
  content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');

function results(content: unknown): HarnessEvent[] {
  if (!Array.isArray(content)) return [];
  return (content as Block[]).flatMap((b): HarnessEvent[] =>
    b?.type === 'tool_result' && b.tool_use_id ? [{ t: 'tool_result', id: b.tool_use_id, ok: !b.is_error, output: resultText(b.content) }] : [],
  );
}

/** A subagent's lifecycle event; undefined for every other system message, and for tasks that aren't subagents. */
function taskOf(e: Record<string, any>): TaskRecord | undefined {
  if (!e.task_id) return;
  const id: string = e.task_id;
  switch (e.subtype) {
    case 'task_started':
      if (e.task_type !== 'local_agent' || e.skip_transcript || e.ambient) return;
      return { t: 'task', id, state: 'started', title: e.description || 'Agent', agentType: e.subagent_type, background: !!e.is_backgrounded };
    case 'task_progress':
      return { t: 'task', id, state: 'progress', doing: e.summary || e.description || undefined, tools: e.usage?.tool_uses, tokens: e.usage?.total_tokens };
    case 'task_updated': {
      const s = e.patch?.status;
      const state = s === 'completed' ? 'done' : s === 'failed' ? 'failed' : s === 'killed' ? 'stopped' : 'progress';
      return { t: 'task', id, state, ...(e.patch?.is_backgrounded ? { background: true } : {}), ...(e.patch?.error ? { error: e.patch.error } : {}) };
    }
    case 'task_notification': {
      const state = e.status === 'completed' ? 'done' : e.status === 'failed' ? 'failed' : 'stopped';
      return {
        t: 'task',
        id,
        state,
        ...(e.summary ? { result: e.summary } : {}),
        ...(e.usage ? { tools: e.usage.tool_uses, tokens: e.usage.total_tokens, durationMs: e.usage.duration_ms } : {}),
      };
    }
  }
}
