// Asks as state (work 084): a permission prompt or a question the agent put to
// a person is an ask in the session's journal before it is anything on a
// screen, and closes once, whoever closes it: a Slack button, a typed reply
// in the thread, an API answer, a message sent while it is open, or an
// interrupt. Asks never expire (work 084 A6: cancelling loses the person's
// place).
//
// Invariants:
// - `open` records `ask.opened` before the prompt renders (prompts.ts calls it
//   first), so a client attached over the API sees the ask no later than Slack;
// - the first close wins: it records `ask.closed`, and every later one is
//   refused (`close` → false for Slack, `409 ask_closed` for the API) except the
//   same answer from the same person, which the API answers 200 (idempotent);
// - an API answer resolves the prompt, which tells Slack (the prompt message is
//   deleted or updated, naming who answered); a Slack answer closes the ask, so
//   an API client sees it close;
// - a steer sent through the API while asks are open closes every one
//   `declined`, closed by its sender, with the answer `{ message, messageSeq }`
//   (the seq of its `message.received`); the message reaches the agent through
//   the prompts' answers. A Slack typed reply closes the prompt it replies to
//   the same way, or answers the one question left (prompts.ts).

import { apiError } from '../../api/writer.js';
import type { ApiError } from '../../protocol-api.js';
import type { Actor, Ask } from '../../api/schema-objects.js';
import { mintId } from '../../session-ids.js';

export type ApprovalAnswer = { decision: 'allow' | 'deny' | 'always'; message?: string; mode?: string };
export type QuestionAnswer = { answers: ReadonlyArray<{ questionId: string; choices: ReadonlyArray<string>; text: string | null }> };
/** A message sent while the ask was open declined it: the message, and its `message.received` seq. */
export type DeclineAnswer = { message: string; messageSeq: number };
export type AskAnswer = ApprovalAnswer | QuestionAnswer;
export type AskStatus = 'answered' | 'dismissed' | 'declined' | 'interrupted';

/** How the API closed an ask, as the prompt that shows it acts on it. */
export type Resolution =
  | { how: 'answered'; answer: AskAnswer; actor: Actor }
  | { how: 'dismissed'; message?: string; actor: Actor };

/** What a prompt registers: the ask's body, and how to act on an answer that came from elsewhere. */
export type AskSpec = (Pick<Ask, 'approval'> & { kind: 'approval' }) | (Pick<Ask, 'question'> & { kind: 'question' });

/** A prompt's hold on its ask. */
export interface AskHandle {
  readonly id: string;
  /** Close it, by a Slack user (their Slack id), an API actor, or the session (neither). False when it closed already. */
  close(status: AskStatus, answer: AskAnswer | DeclineAnswer | null, by?: string | Actor): boolean;
}

/** Where asks are recorded: the session's journal. Returns the event's seq. */
export interface AskJournal {
  sessionId: string;
  /** The turn the ask blocks (opened if none is). */
  turnId(): string;
  record(type: 'ask.opened' | 'ask.closed', ask: Ask, actor: Actor | null): number;
  /** Who a Slack user is, as the API names people. */
  actorOf(slackUserId: string): Actor;
  /** The open asks changed (the session is `waiting` while any is open). */
  changed(open: number): void;
  now?: () => number;
}

interface Entry {
  ask: Ask;
  seq: number;
  resolve(r: Resolution): void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Asks {
  private all = new Map<string, Entry>();

  constructor(private j: AskJournal) {}

  private now() {
    return this.j.now?.() ?? Date.now();
  }

  /** Record a new ask, before its prompt renders; `resolve` acts on an API answer. */
  open(spec: AskSpec, resolve: (r: Resolution) => void): AskHandle {
    const ask: Ask = {
      id: mintId('ak'),
      sessionId: this.j.sessionId,
      turnId: this.j.turnId(),
      kind: spec.kind,
      status: 'open',
      createdAt: iso(this.now()),
      closedAt: null,
      closedBy: null,
      answer: null,
      approval: spec.kind === 'approval' ? spec.approval : null,
      question: spec.kind === 'question' ? spec.question : null,
      secret: null,
    };
    const e: Entry = { ask, seq: 0, resolve };
    this.all.set(ask.id, e);
    e.seq = this.j.record('ask.opened', ask, null);
    this.j.changed(this.openIds().length);
    return {
      id: ask.id,
      close: (status, answer, by) => this.settle(ask.id, status, answer, typeof by === 'string' ? this.j.actorOf(by) : (by ?? null)) !== undefined,
    };
  }

  /** Close an open ask; undefined when it was closed already. */
  private settle(id: string, status: AskStatus, answer: AskAnswer | DeclineAnswer | null, actor: Actor | null): Entry | undefined {
    const e = this.all.get(id);
    if (e?.ask.status !== 'open') return undefined;
    e.ask = { ...e.ask, status, closedAt: iso(this.now()), closedBy: actor, answer };
    e.seq = this.j.record('ask.closed', e.ask, actor);
    this.j.changed(this.openIds().length);
    return e;
  }

  get(id: string): Ask | undefined {
    return this.all.get(id)?.ask;
  }

  openIds(): string[] {
    return [...this.all.values()].filter((e) => e.ask.status === 'open').map((e) => e.ask.id);
  }

  /** `asks.answer`: the first answer wins; the same one again from the same person is answered as it was. */
  answer(id: string, answer: AskAnswer, actor: Actor): { ask: Ask; seq: number } | { error: ApiError } {
    const e = this.all.get(id);
    if (!e) return { error: apiError('ask_not_found', `no ask ${id} in this session`, 404) };
    if (e.ask.kind === 'secret') return { error: apiError('answer_with_secret', 'set the secret instead of answering a secret ask', 400) };
    if (e.ask.status !== 'open') {
      if (e.ask.status === 'answered' && e.ask.closedBy?.id === actor.id && same(e.ask.answer, answer)) return { ask: e.ask, seq: e.seq };
      return { error: apiError('ask_closed', `the ask is ${e.ask.status}`, 409, { ask: e.ask }) };
    }
    const bad = invalid(e.ask, answer);
    if (bad) return { error: apiError('invalid_answer', bad.message, 400, { field: bad.field }) };
    this.settle(id, 'answered', answer, actor);
    e.resolve({ how: 'answered', answer, actor });
    return { ask: e.ask, seq: e.seq };
  }

  /** `asks.dismiss`: closed with no answer; the agent reads it as a denial. */
  dismiss(id: string, message: string | undefined, actor: Actor): { ask: Ask; seq: number } | { error: ApiError } {
    const e = this.all.get(id);
    if (!e) return { error: apiError('ask_not_found', `no ask ${id} in this session`, 404) };
    if (e.ask.status !== 'open') {
      if (e.ask.status === 'dismissed' && e.ask.closedBy?.id === actor.id) return { ask: e.ask, seq: e.seq };
      return { error: apiError('ask_closed', `the ask is ${e.ask.status}`, 409, { ask: e.ask }) };
    }
    this.settle(id, 'dismissed', null, actor);
    e.resolve({ how: 'dismissed', message, actor });
    return { ask: e.ask, seq: e.seq };
  }

  /** The session ends (suspend, quit): every open ask closes `interrupted`, its prompt denied as by an interrupt. */
  closeAll() {
    for (const id of this.openIds()) this.settle(id, 'interrupted', null, null);
  }
}

/** The modes a plan approval may switch to (`mode` on its answer). */
export const PLAN_EXIT_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];

/** Why `answer` does not fit `ask` (asks.mdx), or undefined. */
export function invalid(ask: Ask, answer: AskAnswer): { field: string; message: string } | undefined {
  if (ask.kind === 'approval') {
    if (!('decision' in answer)) return { field: 'decision', message: 'an approval is answered with a decision' };
    if (answer.decision === 'always' && !ask.approval?.alwaysAllows) return { field: 'decision', message: '`always` needs an ask whose alwaysAllows is set' };
    if (answer.mode !== undefined) {
      if (ask.approval?.toolName !== 'ExitPlanMode') return { field: 'mode', message: '`mode` answers a plan approval only' };
      if (answer.decision !== 'allow') return { field: 'mode', message: '`mode` goes with `allow`' };
      if (!PLAN_EXIT_MODES.includes(answer.mode)) return { field: 'mode', message: `the mode after a plan is one of ${PLAN_EXIT_MODES.join(', ')}` };
    }
    return undefined;
  }
  if (!('answers' in answer)) return { field: 'answers', message: 'a question is answered with answers' };
  const qs = ask.question?.questions ?? [];
  for (const [i, a] of answer.answers.entries()) {
    const q = qs.find((x) => x.id === a.questionId);
    if (!q) return { field: `answers[${i}].questionId`, message: `no question ${a.questionId}` };
    const unknown = a.choices.find((c) => !q.options.some((o) => o.label === c));
    if (unknown !== undefined) return { field: `answers[${i}].choices`, message: `no option "${unknown}"` };
    if (a.choices.length > 1 && !q.multiSelect) return { field: `answers[${i}].choices`, message: 'one choice only' };
    if (!a.choices.length && !a.text) return { field: `answers[${i}]`, message: 'a choice or text' };
  }
  const missing = qs.findIndex((q) => !answer.answers.some((a) => a.questionId === q.id));
  if (missing >= 0) return { field: 'answers', message: `question ${qs[missing].id} is not answered` };
  return undefined;
}

/** A question answer as the harness takes it: the text of each choice (or the person's words), by question text. */
export function answersByQuestion(ask: Ask, answer: QuestionAnswer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of answer.answers) {
    const q = ask.question?.questions.find((x) => x.id === a.questionId);
    if (q) out[q.text] = [...a.choices, ...(a.text ? [a.text] : [])].join(', ');
  }
  return out;
}
