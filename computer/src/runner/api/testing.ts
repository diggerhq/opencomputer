// Test helpers for the runner's API (work 084): a Session over a scripted
// harness and a Slack client that logs every call, as the Slack golden and the
// API tests drive it. Imported by *.test.ts only, after their mocks
// (vi.resetModules gives each scenario fresh module state).

import { mkdirSync } from 'node:fs';
import type { WebClient } from '@slack/web-api';
import { Effect, Scope, Stream } from 'effect';
import { vi } from 'vitest';
import { claude } from '../harness/claude/harness.js';
import { type GateAsk, type GateKind, HarnessFailed, type HarnessEvent, type HarnessKind, type Running } from '../harness/types.js';
import { prompts, Session } from '../session.js';

export const CWD = '/tmp/calvin-golden/work';

export type Rec = unknown[];

export interface SetupOptions {
  kind?: 'thread' | 'channel';
  fresh?: boolean;
}

/** A Slack client that logs every call and answers like Slack does, with counter timestamps. */
function slack(rec: Rec) {
  let n = 0;
  const node = (names: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, k) => (k === 'then' ? undefined : node([...names, String(k)])),
      apply: async (_, __, [args]) => {
        const method = names.join('.');
        rec.push({ slack: method, args });
        if (method === 'users.info') return { ok: true, user: { profile: { display_name: `name-${args.user}` } } };
        if (method === 'conversations.info') return { ok: true, channel: { name: 'eng' } };
        if (method === 'files.getUploadURLExternal') return { ok: true, upload_url: 'https://upload.invalid', file_id: 'F1' };
        return { ok: true, ts: `1.${++n}` };
      },
    });
  return node([]) as WebClient;
}

/** The harness the session starts: yields what the scenario feeds it, logs what the session tells it. */
export class FakeHarness {
  private buf: HarnessEvent[] = [];
  private wake?: () => void;
  private err?: Error;
  onInterrupt?: () => void;
  /** While set, the harness's interrupt resolves only when it does (a slow stop). */
  stall?: Promise<void>;
  push(...es: HarnessEvent[]) {
    this.buf.push(...es);
    this.wake?.();
  }
  fail(e: Error) {
    this.err = e;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.buf.length) yield this.buf.shift()!;
      if (this.err) throw this.err;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

/** A session on fake timers (the caller fakes them) over a harness the test feeds. */
export function fakeSession(rec: Rec, o: SetupOptions = {}) {
  mkdirSync(CWD, { recursive: true });
  const st: { h?: FakeHarness; gate?: (name: string, input: Record<string, unknown>, ask: GateAsk) => Promise<unknown> } = {};
  const kind: HarnessKind = {
    id: 'claude',
    caps: claude.caps,
    start(spec): Running {
      const h = (st.h = new FakeHarness());
      st.gate = spec.gate;
      rec.push({ harness: 'start', resume: spec.resume ?? null, mode: spec.mode, model: spec.model, effort: spec.effort });
      const log = (what: string, v?: unknown) => Effect.sync(() => void rec.push({ harness: what, v }));
      return {
        scope: Effect.runSync(Scope.make()),
        harness: {
          id: 'claude',
          caps: claude.caps,
          events: Stream.fromAsyncIterable(h, (e) => new HarnessFailed({ reason: 'exit', message: (e as Error).message })),
          ready: Effect.void,
          send: (input, how) => log('send', { text: input.text, how }),
          interrupt: Effect.sync(() => (rec.push({ harness: 'interrupt' }), h.onInterrupt?.())).pipe(
            Effect.andThen(Effect.suspend(() => (h.stall ? Effect.promise(() => h.stall!) : Effect.void))),
          ),
          setModel: (m) => log('setModel', m),
          models: Effect.succeed([]),
          setMode: (m) => log('setMode', m),
          setEffort: (e) => log('setEffort', e),
          setSpeed: (v) => log('setSpeed', v),
          stopTask: (id) => log('stopTask', id),
        },
      };
    },
  };
  const info = {
    key: o.kind === 'channel' ? 'C2' : 'C1-1.0',
    kind: o.kind ?? 'thread',
    channel: o.kind === 'channel' ? 'C2' : 'C1',
    ...(o.kind === 'channel' ? {} : { threadTs: '1.0' }),
    userId: 'U1',
    teamId: 'T1',
    cwd: CWD,
    title: 'golden',
    mode: 'default' as const,
    ...(o.fresh ? {} : { sdkSessionId: 'sdk-0' }),
  };
  const sess = new Session(info, slack(rec), () => rec.push({ persist: { mode: sess.info.mode, sdk: sess.info.sdkSessionId ?? null } }), {
    busy: (b) => void rec.push({ busy: b }),
  }, kind);
  /** Let the session run: fake time forward in steps, real immediates (Effect's scheduler) in between. */
  const settle = async (ms = 1000) => {
    for (let t = 0; t < ms; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    }
  };
  const step = (label: string) => rec.push({ step: label });
  const t = {
    sess,
    prompts,
    step,
    settle,
    get h() {
      return st.h!;
    },
    async send(text: string, user = 'U1', mentioned: boolean | undefined = true) {
      step(`send ${text}`);
      const p = sess.send(text, user, [], mentioned);
      await settle();
      await p;
    },
    async feed(...es: HarnessEvent[]) {
      step(`feed ${es.map((e) => e.t).join(',')}`);
      st.h!.push(...es);
      await settle();
    },
    /** A gated call: its decision lands in the log when it is made. */
    gate(name: string, input: Record<string, unknown>, id: string, kind: GateKind, canRemember = true) {
      step(`gate ${name}`);
      const ask: GateAsk = { id, kind, signal: new AbortController().signal, canRemember };
      void st.gate!(name, input, ask).then((d) => rec.push({ decision: id, d }));
    },
    /** A button on the newest open prompt. */
    async press(value: string, user = 'U1') {
      step(`press ${value}`);
      const p = [...prompts.values()].at(-1)!;
      await p.onAction(value, user);
      await settle();
    },
  };
  return t;
}

// ---------------------------------------------------------------- the stream

export const first = (input = 1000): HarnessEvent => ({ t: 'request', phase: 'first_token', usage: { input, cacheRead: 200 } });
export const text = (id: string, ...parts: string[]): HarnessEvent[] => [
  { t: 'block', phase: 'start', id, kind: 'text' },
  ...parts.map((delta): HarnessEvent => ({ t: 'live', kind: 'text', id, delta })),
  { t: 'block', phase: 'end', id, kind: 'text' },
  { t: 'text', delta: parts.join('') },
  { t: 'message' },
];
export const thinking = (id: string, s: string): HarnessEvent[] => [
  { t: 'block', phase: 'start', id, kind: 'thinking' },
  { t: 'live', kind: 'thinking', id, delta: s },
  { t: 'block', phase: 'end', id, kind: 'thinking' },
  { t: 'thinking', delta: s },
];
export const tool = (id: string, name: string, input: unknown, parent?: string): HarnessEvent[] =>
  parent
    ? [{ t: 'tool', id, name, input, parent }]
    : [{ t: 'block', phase: 'start', id, kind: 'tool', name }, { t: 'block', phase: 'end', id, kind: 'tool' }, { t: 'message' }, { t: 'tool', id, name, input }];
export const result = (id: string, output: string, ok = true): HarnessEvent => ({ t: 'tool_result', id, ok, output });
export const done = (cost = 0.0123): HarnessEvent => ({ t: 'turn_ended', reason: 'done', usage: { input: 1200, output: 80 }, costTotalUsd: cost });

export type FakeSession = ReturnType<typeof fakeSession>;
