// What Codex asks of Calvin mid-turn (server requests): approvals for a
// command or a file change, questions for the person, and calls to Calvin's
// own tools (served as dynamic tools). Each becomes a gate ask in the seam's
// vocabulary (../types.ts) and its answer Codex's reply.
//
// Invariants:
// - every ask carries an abort signal that fires when Codex stops waiting
//   (`serverRequest/resolved`), when the turn ends, or when the harness
//   closes, so no prompt outlives the call it asks about; its controller is
//   registered synchronously in `request` (app-server.ts calls it so), so a
//   resolution read right after the request still finds it;
// - a request this file does not know is refused (-32601) and logged, never
//   left unanswered: Codex would wait on it forever;
// - `account/chatgptAuthTokens/refresh` is refused: Calvin never holds a
//   ChatGPT token (the proxy does, work 082);
// - Calvin's tools run only after the gate allows them where Claude Code's
//   would ask (default mode, everything but read_thread), and always through
//   `invoke` (schema-checked).

import { log } from '../../../log.js';
import { READ_THREAD_TOOL } from '../../threads.js';
import { type CalvinTool, invoke, jsonSchema } from '../../tool.js';
import { calvinTools } from '../../tools.js';
import type { CalvinTools, Gate, GateDecision, GateKind, Mode } from '../types.js';
import { type Wire, METHOD_NOT_FOUND, RpcError } from './app-server.js';
import { CALVIN_TOOL_PREFIX } from './translate.js';

/** What serving needs from its harness. */
export interface ServeHost {
  gate: Gate;
  readonly mode: Mode;
  setMode(m: Mode): void;
  /** A file change item by id (its approval names only the item). */
  item(id: string): Record<string, Wire> | undefined;
}

type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
const decisionOf = (d: GateDecision): Decision =>
  d.behavior === 'allow' ? (d.remember ? 'acceptForSession' : 'accept') : d.interrupt ? 'cancel' : 'decline';

/** Calvin's tools as Codex dynamic tools, and their calls. */
export class Served {
  private tools: Map<string, CalvinTool>;
  /** Waiting asks by the request's id, aborted when Codex no longer waits. */
  private waiting = new Map<string, AbortController>();
  /** Calvin tools allowed for the rest of the session. */
  private remembered = new Set<string>();

  constructor(
    tools: CalvinTools,
    private host: ServeHost,
  ) {
    this.tools = new Map(calvinTools(tools.cwd, tools.hooks, tools.sendFile, tools.postCard).map((t) => [t.name, t]));
  }

  /** `dynamicTools` for thread/start. */
  specs() {
    return [...this.tools.values()].map((t) => ({ type: 'function' as const, name: t.name, description: t.description, inputSchema: jsonSchema(t) }));
  }

  /** Codex stopped waiting for request `id` (resolved elsewhere, or the turn ended). */
  resolved(id: unknown) {
    const c = this.waiting.get(String(id));
    this.waiting.delete(String(id));
    c?.abort();
  }

  /** Every ask still waiting is moot: the turn ended or the harness closed. */
  abortAll() {
    for (const c of this.waiting.values()) c.abort();
    this.waiting.clear();
  }

  async request(method: string, p: Wire, id: string | number): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const input = { command: commandOf(p), ...(p.cwd ? { cwd: p.cwd } : {}) };
        return { decision: decisionOf(await this.ask(id, 'Bash', 'command', input, p)) };
      }
      case 'item/fileChange/requestApproval': {
        const change = this.host.item(p.itemId)?.changes?.[0] ?? {};
        const input = { file_path: change.path ?? p.grantRoot ?? '', diff: change.diff ?? '' };
        return { decision: decisionOf(await this.ask(id, change.kind?.type === 'add' ? 'Write' : 'Edit', 'edit', input, p)) };
      }
      case 'item/tool/requestUserInput':
        return this.question(id, p);
      case 'item/tool/call':
        return this.call(id, p);
    }
    log.warn(`codex: refused server request ${method}`);
    throw new RpcError(METHOD_NOT_FOUND, `${method} is not supported by Calvin`, method);
  }

  private async ask(id: string | number, name: string, kind: GateKind, input: Record<string, unknown>, p: Wire): Promise<GateDecision> {
    const c = new AbortController();
    this.waiting.set(String(id), c);
    try {
      const d = await this.host.gate(name, input, {
        id: p.itemId ?? p.callId ?? String(id),
        kind,
        signal: c.signal,
        ...(p.reason ? { reason: String(p.reason) } : {}),
        canRemember: kind !== 'question',
      });
      if (d.behavior === 'allow' && d.mode) this.host.setMode(d.mode);
      return d;
    } finally {
      this.waiting.delete(String(id));
    }
  }

  private async question(id: string | number, p: Wire) {
    const qs: Wire[] = Array.isArray(p.questions) ? p.questions : [];
    const input = {
      questions: qs.map((q) => ({
        header: q.header,
        question: q.question,
        options: (q.options ?? []).map((o: Wire) => ({ label: o.label, description: o.description })),
      })),
    };
    const d = await this.ask(id, 'AskUserQuestion', 'question', input, p);
    const answers: Record<string, { answers: string[] }> = {};
    if (d.behavior === 'allow') {
      const given = (d.updatedInput.answers ?? {}) as Record<string, string>;
      for (const q of qs) if (given[q.question] !== undefined) answers[q.id] = { answers: [String(given[q.question])] };
    } else for (const q of qs) answers[q.id] = { answers: [d.message] };
    return { answers };
  }

  private async call(id: string | number, p: Wire) {
    const t = this.tools.get(p.tool);
    const fail = (text: string) => ({ contentItems: [{ type: 'inputText', text }], success: false });
    if (!t || p.namespace) return fail(`No such tool: ${p.tool}`);
    const name = CALVIN_TOOL_PREFIX + t.name;
    const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
    if (this.host.mode !== 'bypassPermissions' && name !== READ_THREAD_TOOL && !this.remembered.has(name)) {
      const d = await this.ask(id, name, 'tool', args, { callId: p.callId });
      if (d.behavior === 'deny') return fail(d.message);
      if (d.remember) this.remembered.add(name);
    }
    const r = await invoke(t, args);
    return { contentItems: r.content.map((c) => ({ type: 'inputText', text: c.text })), success: !r.isError };
  }
}

/** The command an approval is for: the parsed one when Codex has it, else its shell line. */
function commandOf(p: Wire): string {
  const actions = Array.isArray(p.commandActions) ? p.commandActions : [];
  return actions.length === 1 && actions[0]?.command ? actions[0].command : String(p.command ?? '');
}
