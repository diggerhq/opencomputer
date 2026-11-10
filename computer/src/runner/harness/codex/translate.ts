// Codex app-server notifications → the seam's records (../types.ts), as
// observed from 0.163.0 (work 082 contract, section 5 and the recordings in
// testdata/). The only reader of Codex's item and turn shapes.
//
// Invariants:
// - only the session's own thread and its active turn are translated: a
//   subagent's thread (another thread id) and anything outside a turn are
//   dropped, so every record lands inside a `request start` … `turn_ended`;
// - a model response is "first item of output" … `thread/tokenUsage/updated`:
//   `first_token` comes with the first item that is not the person's own
//   message, `end` with that response's usage (`last`), never twice;
// - every block opened is closed exactly once, at its item's completion or,
//   failing that, at the turn's end, so no card or task line is left open;
// - text and thinking stream as `live` deltas and arrive whole at their
//   block's end (the item's own final text when it has one);
// - an `error` Codex will retry is not a record; one it won't is, once, and
//   the turn's own failure does not repeat it.

import type { BlockKind, HarnessEvent, Usage } from '../types.js';
import type { Wire } from './app-server.js';

/** The tool Calvin's own MCP tools are named under for Claude; Codex's dynamic tools take the same names. */
export const CALVIN_TOOL_PREFIX = 'mcp__calvin__';

type Item = Record<string, Wire> & { id: string; type: string };
interface Open {
  kind: BlockKind;
  text: string;
  /** A tool block's call ids (a file change has one per file). */
  calls?: string[];
}

interface RawUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

/** Codex counts cached input inside `inputTokens`; the seam counts it apart, as Anthropic does. */
export function usageOf(u: RawUsage = {}): Usage {
  const cached = u.cachedInputTokens ?? 0;
  return {
    input: Math.max(0, (u.inputTokens ?? 0) - cached),
    output: u.outputTokens ?? 0,
    cacheRead: cached,
    cacheWrite: u.cacheWriteInputTokens ?? 0,
  };
}

const add = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: (a.output ?? 0) + (b.output ?? 0),
  cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
  cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
});

/** A tool item's calls: its seam name and input, and its call ids. */
function callsOf(item: Item): { id: string; name: string; input: unknown }[] {
  switch (item.type) {
    case 'commandExecution': {
      // The command as the model wrote it, where Codex parsed one; else the wrapped shell line.
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      const command = actions.length === 1 && actions[0]?.command ? actions[0].command : item.command;
      return [{ id: item.id, name: 'Bash', input: { command, cwd: item.cwd } }];
    }
    case 'fileChange': {
      const changes: Wire[] = Array.isArray(item.changes) && item.changes.length ? item.changes : [{}];
      return changes.map((c, i) => ({
        id: i ? `${item.id}#${i}` : item.id,
        name: c.kind?.type === 'add' ? 'Write' : 'Edit',
        input: { file_path: c.path, diff: c.diff, ...(c.kind?.move_path ? { move_path: c.kind.move_path } : {}) },
      }));
    }
    case 'dynamicToolCall':
      return [{ id: item.id, name: CALVIN_TOOL_PREFIX + item.tool, input: item.arguments ?? {} }];
    case 'mcpToolCall':
      return [{ id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} }];
    case 'webSearch':
      return [{ id: item.id, name: 'WebSearch', input: { query: item.query } }];
    case 'collabAgentToolCall':
      return [{ id: item.id, name: 'Agent', input: { description: item.prompt ?? item.tool } }];
    case 'imageView':
      return [{ id: item.id, name: 'Read', input: { file_path: item.path } }];
  }
  return [];
}

/** A completed tool item's outcome, for each of its calls. */
function resultOf(item: Item): { ok: boolean; output: string } {
  switch (item.type) {
    case 'commandExecution':
      return { ok: item.status === 'completed' && (item.exitCode ?? 0) === 0, output: String(item.aggregatedOutput ?? '') };
    case 'dynamicToolCall':
      return { ok: item.success !== false && item.status !== 'failed', output: texts(item.contentItems) };
    case 'mcpToolCall':
      return item.error
        ? { ok: false, output: String(item.error.message ?? item.error) }
        : { ok: item.status !== 'failed', output: texts(item.result?.content) };
  }
  return { ok: item.status !== 'failed' && item.status !== 'declined', output: '' };
}

const texts = (xs: unknown) =>
  Array.isArray(xs)
    ? xs
        .map((x: Wire) => x?.text)
        .filter((t) => typeof t === 'string')
        .join('\n')
    : '';

/** Codex's error kinds → the seam's: a limit, or an error with its kind. */
export function errorRecords(info: unknown, message: string, resetAt?: number): HarnessEvent[] {
  const key = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  const say: HarnessEvent = { t: 'text', delta: message };
  switch (key) {
    case 'usageLimitExceeded':
    case 'rateLimitExceeded':
      return [{ t: 'limit', kind: 'rate', ...(resetAt ? { resetAt } : {}) }, say];
    case 'contextWindowExceeded':
      return [{ t: 'limit', kind: 'context' }, say];
    case 'unauthorized':
      return [{ t: 'error', kind: 'auth', code: key, message }, say];
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
      return [{ t: 'error', kind: 'network', code: key, message }, say];
  }
  const code = /model_not_found/.test(message) ? 'model_not_found' : key;
  return [{ t: 'error', kind: 'model', ...(code ? { code } : {}), message }, say];
}

/** One harness's translator: the active turn, its open blocks, and whether a response is streaming. */
export class Translator {
  private thread?: string;
  private turn?: string;
  private responding = false;
  private erred = false;
  private usage: Usage = { input: 0 };
  private open = new Map<string, Open>();
  /** When the account's primary window resets (ms), from the latest rate-limit update. */
  private resetAt?: number;
  /** Items seen in the turn, by id, for the approvals that name them (a file change's paths). */
  readonly items = new Map<string, Item>();

  /** The session's thread: notifications for any other are a subagent's. */
  follow(threadId: string) {
    this.thread = threadId;
  }

  get activeTurn() {
    return this.turn;
  }

  translate(method: string, p: Wire): HarnessEvent[] {
    if (method === 'account/rateLimits/updated') {
      const s = p?.rateLimits?.primary?.resetsAt;
      if (typeof s === 'number') this.resetAt = s * 1000;
      return [];
    }
    if (!p || (p.threadId ?? p.thread?.id) !== this.thread) return [];
    if (method === 'turn/started') return this.started(p.turn?.id);
    const turnId = p.turnId ?? p.turn?.id;
    if (!this.turn || turnId !== this.turn) return [];
    switch (method) {
      case 'item/started':
        return this.itemStarted(p.item);
      case 'item/completed':
        return this.itemCompleted(p.item);
      case 'item/agentMessage/delta':
        return this.delta('text', p.itemId, p.delta);
      case 'item/reasoning/summaryTextDelta':
        return this.delta('thinking', p.itemId, p.delta);
      case 'item/reasoning/summaryPartAdded':
        return this.delta('thinking', p.itemId, '\n\n');
      case 'thread/tokenUsage/updated': {
        const u = usageOf(p.tokenUsage?.last);
        this.usage = add(this.usage, u);
        this.responding = false;
        return [{ t: 'message' }, { t: 'request', phase: 'end', usage: u }];
      }
      case 'error':
        if (p.willRetry || this.erred) return [];
        this.erred = true;
        return errorRecords(p.error?.codexErrorInfo, String(p.error?.message ?? 'Codex failed'), this.resetAt);
      case 'turn/completed':
        return this.completed(p.turn ?? {});
    }
    return [];
  }

  private started(id?: string): HarnessEvent[] {
    if (!id) return [];
    this.turn = id;
    this.responding = this.erred = false;
    this.usage = { input: 0 };
    this.open.clear();
    this.items.clear();
    return [{ t: 'request', phase: 'start' }];
  }

  /** Output began: the first item of a response is its first token. */
  private output(): HarnessEvent[] {
    if (this.responding) return [];
    this.responding = true;
    return [{ t: 'request', phase: 'first_token' }];
  }

  private itemStarted(item?: Item): HarnessEvent[] {
    if (!item?.id || item.type === 'userMessage' || this.open.has(item.id)) return [];
    this.items.set(item.id, item);
    const out = this.output();
    switch (item.type) {
      case 'agentMessage':
      case 'reasoning': {
        const kind = item.type === 'agentMessage' ? 'text' : 'thinking';
        this.open.set(item.id, { kind, text: '' });
        out.push({ t: 'block', phase: 'start', id: item.id, kind });
        return out;
      }
      case 'contextCompaction':
        this.open.set(item.id, { kind: 'other', text: '' });
        out.push({ t: 'compaction', phase: 'start' });
        return out;
    }
    const calls = callsOf(item);
    if (!calls.length) return out;
    this.open.set(item.id, { kind: 'tool', text: '', calls: calls.map((c) => c.id) });
    for (const c of calls) out.push({ t: 'block', phase: 'start', id: c.id, kind: 'tool', name: c.name }, { t: 'tool', ...c });
    return out;
  }

  private delta(kind: 'text' | 'thinking', id: string, delta: unknown): HarnessEvent[] {
    const b = this.open.get(id);
    if (!b || typeof delta !== 'string' || !delta) return [];
    b.text += delta;
    return [{ t: 'live', kind, id, delta }];
  }

  private itemCompleted(item?: Item): HarnessEvent[] {
    if (!item?.id || item.type === 'userMessage') return [];
    // An item that completes without having started (a fast tool, say) opens and closes at once.
    const out = this.open.has(item.id) ? [] : this.itemStarted(item);
    const b = this.open.get(item.id);
    if (!b) return out;
    this.items.set(item.id, item);
    this.open.delete(item.id);
    if (item.type === 'contextCompaction') return [...out, { t: 'compaction', phase: 'end' }];
    if (b.kind === 'text') return [...out, ...this.close(item.id, b, typeof item.text === 'string' && item.text ? item.text : b.text)];
    if (b.kind === 'thinking') {
      const summary = Array.isArray(item.summary) ? item.summary.join('\n\n') : '';
      return [...out, ...this.close(item.id, b, summary || b.text)];
    }
    const r = resultOf(item);
    for (const id of b.calls ?? []) out.push({ t: 'block', phase: 'end', id, kind: 'tool' }, { t: 'tool_result', id, ok: r.ok, output: r.output });
    return out;
  }

  private close(id: string, b: Open, text: string): HarnessEvent[] {
    if (b.kind === 'tool') return (b.calls ?? []).map((c) => ({ t: 'block', phase: 'end', id: c, kind: 'tool' }) as const);
    if (b.kind === 'other') return [{ t: 'compaction', phase: 'end' }];
    return [
      { t: 'block', phase: 'end', id, kind: b.kind },
      { t: b.kind, delta: text },
    ];
  }

  private completed(turn: { status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null }): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    for (const [id, b] of this.open) out.push(...this.close(id, b, b.text));
    this.open.clear();
    if (turn.status === 'failed' && turn.error && !this.erred) {
      out.push(...errorRecords(turn.error.codexErrorInfo, String(turn.error.message ?? 'Codex failed'), this.resetAt));
    }
    const info = turn.error?.codexErrorInfo;
    const detail = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : 'failed';
    const ended: HarnessEvent =
      turn.status === 'completed'
        ? { t: 'turn_ended', reason: 'done', usage: this.usage }
        : turn.status === 'interrupted'
          ? { t: 'turn_ended', reason: 'interrupted', detail: 'interrupted', usage: this.usage }
          : { t: 'turn_ended', reason: 'error', detail, usage: this.usage };
    out.push(ended);
    this.turn = undefined;
    this.responding = this.erred = false;
    this.items.clear();
    return out;
  }
}
