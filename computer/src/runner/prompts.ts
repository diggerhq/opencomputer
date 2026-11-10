// Prompts the agent puts to the person: a permission request (buttons: Allow /
// Allow for session / Deny), a plan to approve, or an AskUserQuestion (one
// button per option). Each is a Slack message whose buttons resolve a
// GateDecision; a typed reply in the thread while one is open answers it
// instead. Prompts are transient like Claude Code's dialog: the decision is
// recorded on the task line and the prompt message goes away. A plan stays
// (it is content), and work continues in a new message below it.
//
// Every prompt is an ask (api/asks.ts, work 084) before it renders: it is
// recorded first, the first answer wins wherever it comes from (a button, a
// typed reply, the API), and an API answer resolves the prompt as a button
// would, naming who answered. A steer sent through the API while prompts are
// open declines every one of them (work 084 A6, replyToPrompts).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { KnownBlock } from '@slack/types';
import { encodeActionId } from '../protocol.js';
import type { GateAsk, GateDecision } from './harness/types.js';
import type { Task } from './segment.js';
import { SEND_FILE_TOOL } from './send-file.js';
import { REQUEST_SECRET_TOOL } from './session-secrets.js';
import type { SessionInfo } from './session.js';
import { SPAWN_TOOL } from './spawn.js';
import { POST_THREAD_TOOL } from './threads.js';
import type { Surface } from './api/surface.js';
import type { Reply } from './prompt-replies.js';
import { answersByQuestion, type AskAnswer, type Asks, type AskStatus, type DeclineAnswer, type Resolution } from './api/asks.js';

/** What a prompt needs from the session that shows it. */
export interface PromptHost {
  info: SessionInfo;
  thread: Surface;
  /** The session's asks, where the API journals it. */
  readonly asks?: Asks;
  /** The prompt a typed reply answers, by prompt id. */
  openPrompt?: string;
  patchTask(id: string, patch: Partial<Task>): void;
  /** Finalize the live message; what follows continues in a new one below. */
  rotate(): void;
  persist(): void;
}

/** An open prompt waiting on a Slack button. */
export interface Pending {
  session: PromptHost;
  onAction(value: string, user: string): Promise<void>;
  /** A message sent while the prompt is open. */
  onText(text: string, user: string, reply?: Reply): Promise<void>;
  cancel(): Promise<void>;
  /** Its ask, where the API journals it. */
  askId?: string;
  /** A Slack typed reply now would answer it (one question left), not decline it. */
  answersText?(): boolean;
}

/** Open prompts (permission / question) waiting on a Slack button, by prompt id. */
export const prompts = new Map<string, Pending>();

/** An API answer that may come before the prompt is posted: held until the prompt can act on it. */
function relay() {
  let act: ((r: Resolution) => void) | undefined;
  let early: Resolution | undefined;
  return {
    resolve: (r: Resolution) => (act ? act(r) : (early = r)),
    bind(f: (r: Resolution) => void) {
      act = f;
      if (early) f(early);
    },
  };
}

/** How a decision closes its ask (a decision made in Slack, or by the session). */
function closeAs(res: GateDecision, said?: string, reply?: Reply): [AskStatus, AskAnswer | DeclineAnswer | null] {
  if (res.behavior === 'allow') return ['answered', { decision: res.remember || res.mode ? 'always' : 'allow', ...(res.mode ? { mode: res.mode } : {}) }];
  if (res.interrupt || res.message === 'aborted') return ['interrupted', null];
  // A message typed while the prompt was open declined it (work 084 A6).
  if (said !== undefined) return ['declined', { message: said, messageSeq: reply?.messageSeq ?? 0 }];
  return ['answered', { decision: 'deny' }];
}

const nameOf = (r: Resolution) => r.actor.name || r.actor.id;

/** How a plan approval names the mode it switched to. */
const MODE_LABEL: Record<string, string> = { acceptEdits: 'auto-accepting edits', auto: 'auto mode', bypassPermissions: 'bypassing permissions' };

export async function permissionPrompt(host: PromptHost, name: string, input: Record<string, unknown>, ask: GateAsk): Promise<GateDecision> {
  const pid = randomUUID().slice(0, 8);
  const isPlan = ask.kind === 'plan';
  if (!isPlan) host.patchTask(ask.id, { details: 'waiting for approval ↓', waiting: true });
  const title = isPlan
    ? 'Plan ready for review'
    : name === SPAWN_TOOL
      ? 'Claude wants to start a new thread'
      : name === SEND_FILE_TOOL
        ? 'Claude wants to post a file to this thread'
        : name === REQUEST_SECRET_TOOL
          ? 'Claude wants to ask for a secret'
        : name === POST_THREAD_TOOL
          ? 'Claude wants to post in another thread'
        : (ask.title ?? `Claude wants to use ${name}`);
  const preview = previewFor(name, input, host.info.cwd);
  const buttons: { text: string; value: string; style?: 'primary' | 'danger' }[] = isPlan
    ? [
        { text: 'Approve · auto-accept edits', value: 'accept', style: 'primary' },
        { text: 'Approve · ask before edits', value: 'allow' },
        { text: 'Keep planning', value: 'deny' },
      ]
    : [
        { text: 'Allow', value: 'allow', style: 'primary' },
        ...(ask.canRemember ? [{ text: `Allow ${name} for this session`, value: 'always' }] : []),
        { text: 'Deny', value: 'deny', style: 'danger' },
      ];
  const head: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}*${(ask.description ?? ask.reason) ? `\n${ask.description ?? ask.reason}` : ''}` } },
    ...(preview ? [{ type: 'markdown', text: preview } as KnownBlock] : []),
  ];
  const api = relay();
  const tracked = host.asks?.open(
    { kind: 'approval', approval: { toolName: name, callId: ask.id, input: input as never, title, alwaysAllows: isPlan ? 'acceptEdits' : ask.canRemember ? name : null } },
    api.resolve,
  );
  const ts = await host.thread.post(title, [
    ...head,
    {
      type: 'actions',
      elements: buttons.map((b) => ({
        type: 'button',
        text: { type: 'plain_text', text: b.text },
        action_id: encodeActionId(host.info.key, pid, b.value),
        value: b.value,
        ...(b.style ? { style: b.style } : {}),
      })),
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'or reply here to decline and say what to do instead' }] },
  ]);

  return new Promise<GateDecision>((resolve) => {
    let done = false;
    const finish = async (res: GateDecision, label: string, user?: string, by?: string, said?: string, reply?: Reply) => {
      if (done) return;
      done = true;
      prompts.delete(pid);
      if (host.openPrompt === pid) host.openPrompt = undefined;
      tracked?.close(...closeAs(res, said, reply), reply?.by ?? user);
      const who = by ?? (user ? await host.thread.userName(user) : '');
      resolve(res);
      if (isPlan) {
        host.rotate();
        const md = `${label}${who ? ` · ${who}` : ''}`;
        await host.thread.update(ts, md, [...head, { type: 'context', elements: [{ type: 'mrkdwn', text: md }] }], 'update prompt');
        return;
      }
      host.patchTask(ask.id, { details: `${label}${who ? ` by ${who}` : ''}`, waiting: false });
      await host.thread.delete(ts, 'delete prompt');
    };
    const act = async (value: string, user?: string, by?: string) => {
        if (value === 'allow') return finish({ behavior: 'allow', updatedInput: input }, isPlan ? '✅ plan approved' : 'allowed', user, by);
        if (value === 'always')
          return finish({ behavior: 'allow', updatedInput: input, remember: true }, `allowed for session`, user, by);
        // `accept` (Slack's button), or `mode:<mode>` (an API plan approval's `mode`).
        const mode = value === 'accept' ? 'acceptEdits' : value.startsWith('mode:') ? value.slice(5) : undefined;
        if (mode) {
          host.info.mode = mode as SessionInfo['mode'];
          host.persist();
          return finish(
            {
              behavior: 'allow',
              updatedInput: input,
              mode: mode as SessionInfo['mode'],
            },
            `✅ plan approved · ${MODE_LABEL[mode] ?? mode}`,
            user,
            by,
          );
        }
        return finish(
          { behavior: 'deny', message: isPlan ? 'The user wants to keep planning.' : 'The user denied this action.' },
          isPlan ? '↩︎ keep planning' : 'denied',
          user,
          by,
        );
    };
    const declined = (text: string, user?: string, by?: string, reply?: Reply) =>
      finish(
        { behavior: 'deny', message: reply?.quiet ? 'The user declined this and sent a message, given with another call.' : `The user declined and said: ${text}` },
        'declined',
        user,
        by ?? (reply?.by ? reply.by.name || reply.by.id : undefined),
        text,
        reply,
      );
    prompts.set(pid, {
      session: host,
      onAction: (value, user) => act(value, user),
      askId: tracked?.id,
      onText: async (text, user, reply) => {
        await declined(text, user, undefined, reply);
        host.rotate(); // the reply is now below; continue under it
      },
      cancel: () => finish({ behavior: 'deny', message: 'Interrupted by the user.', interrupt: true }, 'interrupted'),
    });
    host.openPrompt = pid;
    ask.signal.addEventListener('abort', () => void finish({ behavior: 'deny', message: 'aborted' }, 'cancelled'));
    api.bind((r) => {
      if (r.how === 'dismissed') return void finish({ behavior: 'deny', message: r.message ? `The user dismissed this and said: ${r.message}` : 'The user denied this action.' }, 'dismissed', undefined, nameOf(r));
      const a = r.answer as Extract<AskAnswer, { decision: unknown }>;
      if (a.decision === 'deny' && a.message) return void declined(a.message, undefined, nameOf(r));
      if (isPlan && a.mode && a.mode !== 'default') return void act(`mode:${a.mode}`, undefined, nameOf(r));
      void act(a.decision === 'always' && isPlan ? 'accept' : a.decision, undefined, nameOf(r));
    });
  });
}

export async function questionPrompt(
  host: PromptHost,
  input: { questions: any[] },
  toolUseID: string,
  signal: AbortSignal,
): Promise<GateDecision> {
  const pid = randomUUID().slice(0, 8);
  host.patchTask(toolUseID, { details: 'waiting for your answer ↓', waiting: true });
  const qs = input.questions ?? [];
  const answers: Record<string, string> = {};
  const render = (final = false): KnownBlock[] =>
    qs.flatMap((q, qi): KnownBlock[] => {
      const a = answers[q.question];
      const head: KnownBlock = {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${q.header ?? 'Question'}* — ${q.question}${a ? `\n→ *${a}*` : ''}` },
      };
      if (a || final) return [head];
      return [
        head,
        {
          type: 'actions',
          elements: q.options.map((o: any, oi: number) => ({
            type: 'button',
            text: { type: 'plain_text', text: o.label.slice(0, 75) },
            action_id: encodeActionId(host.info.key, pid, `${qi}.${oi}`),
            value: `${qi}.${oi}`,
          })),
        },
        ...(q.options.some((o: any) => o.description)
          ? [
              {
                type: 'context',
                elements: [
                  { type: 'mrkdwn', text: q.options.map((o: any) => `*${o.label}*: ${o.description}`).join('  ·  ').slice(0, 2900) },
                ],
              } as KnownBlock,
            ]
          : []),
      ];
    });
  const api = relay();
  const tracked = host.asks?.open(
    {
      kind: 'question',
      question: {
        questions: qs.map((q, i) => ({
          id: `q${i}`,
          header: String(q.header ?? 'Question'),
          text: String(q.question ?? ''),
          multiSelect: !!q.multiSelect,
          options: (q.options ?? []).map((o: { label?: unknown; description?: string }) => ({ label: String(o.label), description: o.description ?? null })),
        })),
      },
    },
    api.resolve,
  );
  let lastUser: string | undefined;
  const ts = await host.thread.post(qs[0]?.question ?? 'Question', [
    ...render(),
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'or reply here with your own answer' }] },
  ]);

  return new Promise<GateDecision>((resolve) => {
    let done = false;
    const redraw = (final: boolean) => host.thread.update(ts, 'Question', render(final), 'update question');
    const finish = async (res: GateDecision, note = 'cancelled', as?: AskStatus, reply?: Reply, said = '') => {
      if (done) return;
      done = true;
      prompts.delete(pid);
      if (host.openPrompt === pid) host.openPrompt = undefined;
      const status = as ?? (res.behavior === 'allow' ? 'answered' : 'interrupted');
      const given = qs.map((q, i) => {
        const a = answers[q.question];
        const opt = q.options?.some((o: { label?: unknown }) => o.label === a);
        return { questionId: `q${i}`, choices: a && opt ? [a] : [], text: a && !opt ? a : null };
      });
      const closing = status === 'answered' ? { answers: given } : status === 'declined' ? { message: said, messageSeq: reply?.messageSeq ?? 0 } : null;
      tracked?.close(status, closing, reply?.by ?? lastUser);
      resolve(res);
      const summary = Object.values(answers).join(' · ');
      host.patchTask(toolUseID, {
        details: res.behavior === 'allow' ? `→ ${summary}` : [summary && `→ ${summary}`, note].filter(Boolean).join(' · '),
        waiting: false,
      });
      await host.thread.delete(ts, 'delete question');
    };
    const answer = async (qi: number, value: string, reply?: Reply) => {
      const q = qs[qi];
      if (!q || answers[q.question]) return;
      answers[q.question] = value;
      if (qs.every((x) => answers[x.question])) await finish({ behavior: 'allow', updatedInput: { ...input, answers } }, undefined, undefined, reply);
      else await redraw(false);
    };
    prompts.set(pid, {
      session: host,
      onAction: async (value, user) => {
        lastUser = user;
        const [qi, oi] = value.split('.').map(Number);
        await answer(qi, qs[qi]?.options?.[oi]?.label);
      },
      // A typed reply always closes the prompt. In Slack it answers the last
      // open question; with several open, or from an API steer, it goes to
      // Claude as the user's words, so a side remark ("what's the status?")
      // never becomes an answer.
      askId: tracked?.id,
      answersText: () => qs.filter((q) => !answers[q.question]).length <= 1,
      onText: async (text, user, reply) => {
        lastUser = user;
        const open = qs.filter((q) => !answers[q.question]);
        if (open.length <= 1 && !reply?.by) await answer(qs.indexOf(open[0]), text, reply);
        else {
          const chosen = Object.entries(answers).map(([q, a]) => `"${q}" → ${a}`);
          await finish(
            {
              behavior: 'deny',
              message:
                (reply?.quiet ? 'The user sent a message instead of answering, given with another call.' : `The user replied in text instead of answering the questions: ${text}`) +
                (chosen.length ? `\nAnswered with buttons before that: ${chosen.join('; ')}` : ''),
            },
            'replied in text',
            'declined',
            reply,
            text,
          );
        }
        host.rotate();
      },
      cancel: () => finish({ behavior: 'deny', message: 'Interrupted by the user.', interrupt: true }),
    });
    host.openPrompt = pid;
    signal.addEventListener('abort', () => void finish({ behavior: 'deny', message: 'aborted' }));
    api.bind((r) => {
      const ask = tracked && host.asks?.get(tracked.id);
      if (r.how === 'answered' && ask && 'answers' in r.answer) {
        Object.assign(answers, answersByQuestion(ask, r.answer));
        return void finish({ behavior: 'allow', updatedInput: { ...input, answers } });
      }
      const why = `The user dismissed the questions${r.how === 'dismissed' && r.message ? ` and said: ${r.message}` : '.'}`;
      void finish({ behavior: 'deny', message: why }, `dismissed by ${nameOf(r)}`, r.how);
    });
  });
}

/** What the prompt shows of the tool call: the command, the edit as a diff, the plan. */
export function previewFor(name: string, input: any, cwd: string): string | undefined {
  const fence = (s: string, n = 2500) => '```\n' + (s.length > n ? s.slice(0, n) + '\n…' : s) + '\n```';
  switch (name) {
    case 'Bash':
      return fence(String(input.command ?? ''));
    case 'Edit':
      // A unified diff where the harness gives one (Codex's file changes); Claude's Edit gives old and new.
      if (typeof input.diff === 'string') return `\`${path.relative(cwd, input.file_path ?? '')}\`\n` + fence(input.diff);
      return (
        `\`${path.relative(cwd, input.file_path ?? '')}\`\n` +
        fence(
          String(input.old_string ?? '')
            .split('\n')
            .map((l) => '- ' + l)
            .join('\n') +
            '\n' +
            String(input.new_string ?? '')
              .split('\n')
              .map((l) => '+ ' + l)
              .join('\n'),
        )
      );
    case 'Write':
      return `\`${path.relative(cwd, input.file_path ?? '')}\`\n` + fence(String(input.content ?? ''), 1500);
    case 'ExitPlanMode':
      return String(input.plan ?? '').slice(0, 11000);
    case SPAWN_TOOL:
      return `↳ ${input.task ?? ''}\nBrief: \`${input.brief ?? ''}\``;
    case POST_THREAD_TOOL:
      return `${input.url ?? `${input.channel ?? ''} ${input.ts ?? ''}`}\n` + fence(String(input.text ?? ''), 1500);
    case SEND_FILE_TOOL:
      return `\`${path.relative(cwd, path.resolve(cwd, input.path ?? ''))}\`` + (input.comment ? `\n> ${String(input.comment).slice(0, 500)}` : '');
    default:
      return fence(JSON.stringify(input, null, 2), 1500);
  }
}
