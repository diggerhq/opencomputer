// The Slack golden (work 084): what a Session posts to Slack for a scripted
// harness stream, recorded once from the code before the API tap existed
// (commit aa70f0e) and replayed against today's. Every Slack Web API call, every
// command to the harness and every gate decision goes into one log per
// scenario; the log must match the recorded one byte for byte, with the API
// tap attached and without it, so the tap provably changes nothing a person
// sees in Slack.
//
// Determinism: time is fake (Date, timers, performance), ids come from a
// counter (node:crypto's randomUUID), git answers are fixed, and modules are
// loaded fresh per scenario (the names cache and open prompts are module state).
// `RECORD_GOLDEN=1` rewrites the fixtures.
//
// The tap's pass also keeps the journal it wrote: every event decodes as an
// Event with its EVENT_DATA shape, and the list (ids and times normalised)
// must match `golden/<scenario>.journal.ndjson`, recorded from this tap and read
// through by hand (`RECORD_JOURNAL=1` rewrites those).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertEvent, tempSession } from '../../api/testing.js';
import type { JournalEvent } from '../../protocol.js';
import { CWD, done, first, result, type SetupOptions, text, thinking, tool } from './testing.js';

const ids = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:crypto', async (orig) => ({
  ...(await orig<object>()),
  randomUUID: () => `${(++ids.n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
}));
vi.mock('../harness/claude/process.js', () => ({
  startHarness: () => {
    throw new Error('the golden runs a fake harness');
  },
}));
vi.mock('../harness/claude/mcp.js', () => ({ calvinServer: () => ({}) }));
vi.mock('../../workspace.js', async (orig) => ({
  ...(await orig<object>()),
  gitBranch: async () => 'main',
  gitDiff: async () => 'diff --git a/x.ts b/x.ts',
}));

const DIR = path.join(import.meta.dirname, 'golden');
const RECORD = process.env.RECORD_GOLDEN === '1';
const RECORD_JOURNAL = process.env.RECORD_JOURNAL === '1';

type Rec = unknown[];

async function setup(rec: Rec, o: SetupOptions = {}) {
  ids.n = 0;
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    now: new Date('2026-10-26T00:00:00Z'),
  });
  const { fakeSession } = await import('./testing.js');
  return fakeSession(rec, o);
}

type T = Awaited<ReturnType<typeof setup>>;

const SCENARIOS: Record<string, { o?: Parameters<typeof setup>[1]; run(t: T): Promise<void> }> = {
  plain: {
    o: { fresh: true },
    async run(t) {
      await t.send('hi there');
      await t.feed({ t: 'session', ref: { harness: 'claude', id: 'sdk-1' }, model: 'claude-opus-4-5' }, { t: 'request', phase: 'start' });
      await t.feed(first(), ...thinking('0', 'pondering the greeting'));
      await t.settle(2000);
      await t.feed(...text('1', 'Hello! ', 'How can I ', 'help?'), { t: 'request', phase: 'end' });
      await t.feed(done());
      await t.settle(3000);
    },
  },
  tools: {
    async run(t) {
      await t.send('fix the build');
      await t.feed(first(), ...text('0', 'Looking.'), ...tool('tu_1', 'Bash', { command: 'ls src', description: 'List the sources' }));
      await t.feed(result('tu_1', 'a.ts\nb.ts'));
      await t.feed(first(1500), ...tool('tu_2', 'Edit', { file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' }));
      await t.feed(result('tu_2', 'ok'));
      await t.feed(first(1600), ...tool('tu_3', 'Task', { description: 'check tests', prompt: 'run them', subagent_type: 'general' }));
      await t.feed({ t: 'task', id: 'tk_1', state: 'started', title: 'check tests', agentType: 'general' });
      await t.feed(...tool('tu_4', 'Read', { file_path: `${CWD}/b.ts` }, 'tu_3'), { t: 'task', id: 'tk_1', state: 'progress', doing: 'reading b.ts', tools: 1 });
      await t.feed({ t: 'task', id: 'tk_1', state: 'done', result: 'all green', durationMs: 4000 }, result('tu_3', 'all green'));
      await t.feed(result('tu_9', 'unknown call'), { t: 'tool_result', id: 'tu_2', ok: false, output: 'late failure' });
      await t.feed(first(1700), ...text('1', 'Fixed: ', 'a.ts now builds.'), done(0.05));
      await t.settle(3000);
    },
  },
  approval: {
    async run(t) {
      await t.send('clean up');
      await t.feed(first(), ...tool('tu_1', 'Bash', { command: 'rm -rf build' }));
      t.gate('Bash', { command: 'rm -rf build' }, 'tu_1', 'command');
      await t.settle();
      await t.press('allow', 'U2');
      await t.feed(result('tu_1', ''));
      await t.feed(first(), ...tool('tu_2', 'Write', { file_path: `${CWD}/x.ts`, content: 'x' }));
      t.gate('Write', { file_path: `${CWD}/x.ts`, content: 'x' }, 'tu_2', 'edit', false);
      await t.settle();
      await t.send('no, put it in tmp/');
      await t.feed(result('tu_2', 'denied', false));
      await t.feed(first(), ...tool('tu_3', 'Bash', { command: 'make' }));
      t.gate('Bash', { command: 'make' }, 'tu_3', 'command');
      await t.settle();
      await t.press('always');
      await t.feed(result('tu_3', 'built'));
      await t.feed(first(), ...tool('tu_4', 'ExitPlanMode', { plan: '1. do it\n2. ship it' }));
      t.gate('ExitPlanMode', { plan: '1. do it\n2. ship it' }, 'tu_4', 'plan');
      await t.settle();
      await t.press('accept');
      await t.feed(result('tu_4', 'approved'), first(), ...text('1', 'Done.'), done());
      await t.settle(3000);
    },
  },
  question: {
    async run(t) {
      await t.send('pick a color');
      const questions = [
        { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
        { question: 'Which shade?', header: 'Shade', multiSelect: false, options: [{ label: 'Light' }, { label: 'Dark' }] },
      ];
      await t.feed(first(), ...tool('tu_1', 'AskUserQuestion', { questions }));
      t.gate('AskUserQuestion', { questions }, 'tu_1', 'question');
      await t.settle();
      await t.press('0.1');
      await t.send('a deep navy');
      await t.feed(result('tu_1', 'answered'), first(), ...text('1', 'Navy it is.'), done());
      await t.settle(2000);
      await t.send('again');
      await t.feed(first(), ...tool('tu_2', 'AskUserQuestion', { questions }));
      t.gate('AskUserQuestion', { questions }, 'tu_2', 'question');
      await t.settle();
      await t.send("what's the status?");
      await t.feed(result('tu_2', 'replied', false), first(), ...text('2', 'Working on it.'), done());
      await t.settle(3000);
    },
  },
  steer: {
    async run(t) {
      await t.send('write the docs');
      await t.feed(first(), ...text('0', 'Starting on ', 'the docs.'), ...tool('tu_1', 'Bash', { command: 'ls docs' }));
      await t.send('also the changelog', 'U2');
      await t.feed(result('tu_1', 'index.md'), first(), ...text('1', 'And the changelog.'));
      t.h.onInterrupt = () => t.h.push({ t: 'turn_ended', reason: 'error', detail: 'error_during_execution', usage: { input: 1 } });
      await t.send('!! stop, do the readme instead');
      await t.feed(first(), ...text('2', 'Readme then.'), done());
      await t.settle(3000);
    },
  },
  interrupt: {
    async run(t) {
      await t.send('deploy');
      await t.feed(first(), ...text('0', 'Deploying.'), ...tool('tu_1', 'Bash', { command: './deploy.sh' }));
      t.gate('Bash', { command: './deploy.sh' }, 'tu_1', 'command');
      await t.settle();
      t.h.onInterrupt = () => t.h.push({ t: 'turn_ended', reason: 'error', detail: 'error_during_execution', usage: { input: 1 } });
      t.step('interrupt');
      await t.sess.interrupt();
      await t.settle(3000);
      await t.send('try again later');
      await t.feed(first(), ...text('1', 'Ok.'), done());
      await t.settle(3000);
    },
  },
  error: {
    async run(t) {
      await t.send('do the thing');
      await t.feed(first(), { t: 'error', kind: 'model', code: 'model_not_found', message: 'no such model' }, { t: 'message' }, { t: 'text', delta: 'API Error: no such model' });
      await t.feed({ t: 'turn_ended', reason: 'error', detail: 'error_max_turns', usage: { input: 10 } });
      await t.settle(3000);
      await t.send('again');
      await t.feed(first(), ...text('0', 'Part'));
      t.step('harness dies');
      t.h.fail(new Error('boom'));
      await t.settle(3000);
      await t.send('once more');
      await t.feed(first(), ...text('1', 'Back.'), done());
      await t.settle(3000);
    },
  },
  channel: {
    o: { kind: 'channel', fresh: true },
    async run(t) {
      await t.send('refactor', 'U1', false);
      await t.feed({ t: 'session', ref: { harness: 'claude', id: 'sdk-c' }, model: 'claude-sonnet-4-5' });
      await t.feed(first(), ...tool('tu_1', 'Edit', { file_path: `${CWD}/a.ts`, old_string: 'x', new_string: 'y' }), result('tu_1', 'ok'));
      await t.feed(first(), ...text('0', 'Refactored.'), done(0.2));
      await t.settle(3000);
      t.step('mode');
      await t.sess.setMode('plan');
      await t.settle();
      await t.send('quiet check', 'U1', false);
      await t.feed(first(), ...text('1', '<no-', 'reply/>'), done(0.21));
      await t.settle(3000);
    },
  },
};

/** One scenario's log, as the fixture holds it. */
async function play(name: string, attach?: (t: T) => void | Promise<void>) {
  const rec: Rec = [];
  const sc = SCENARIOS[name];
  const t = await setup(rec, sc.o);
  await attach?.(t);
  await sc.run(t);
  t.sess.end();
  vi.useRealTimers();
  return `${JSON.stringify(rec, null, 1)}\n`;
}

afterEach(() => vi.useRealTimers());

/** Ids and times out of a journal, so it compares across runs: each id becomes its kind and order of appearance. */
function normalise(events: JournalEvent[]): string {
  const seen = new Map<string, string>();
  const id = (v: string) => seen.get(v) ?? (seen.set(v, `${v.split('_')[0]}#${seen.size + 1}`), seen.get(v)!);
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? (/^[a-z]{2,4}_[a-z0-9]{8,}$/.test(v) ? id(v) : v)
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'at' && k !== 'ts').map(([k, x]) => [k, walk(x)]))
    : v;
  return `${events.map((e) => JSON.stringify(walk({ seq: e.seq, type: e.type, turnId: e.turnId, actor: e.actor?.id ?? null, data: e.data }))).join('\n')}\n`;
}

/** The tap on a session, over a journal in a temp dir. */
async function tapped(name: string) {
  const tmp = tempSession();
  const { SessionLog } = await import('../../api/session-log.js');
  const log = await SessionLog.open(tmp.file, {
    sessionId: tmp.sessionId, epoch: 1, lastSeq: 0, seed: { sessionId: tmp.sessionId, owner: { id: 'usr_owner00001', name: 'Owner', email: null } },
  });
  const got = await play(name, async (t) => {
    const { SessionApi } = await import('./api.js');
    new SessionApi(log, t.sess, { owner: { slackUserId: 'U1', userId: 'usr_owner00001', name: 'Owner', dir: 'u1', gitName: 'Owner', gitEmail: 'o@x' }, suspend() {} });
  });
  const events = log.journal.read(0, 10_000);
  await log.release();
  tmp.cleanup();
  return { got, events };
}

describe('Slack golden (work 084): what a session posts is unchanged', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const file = path.join(DIR, `${name}.json`);
    it(name, async () => {
      const got = await play(name);
      if (RECORD) return void (mkdirSync(DIR, { recursive: true }), writeFileSync(file, got));
      expect(existsSync(file), `no fixture ${file}: record it at aa70f0e with RECORD_GOLDEN=1`).toBe(true);
      expect(got).toBe(readFileSync(file, 'utf8'));
    });
    it(`${name}, with the API tap`, async () => {
      const { got, events } = await tapped(name);
      expect(got).toBe(readFileSync(file, 'utf8'));
      for (const e of events) assertEvent(e);
      const jfile = path.join(DIR, `${name}.journal.ndjson`);
      if (RECORD_JOURNAL) return void writeFileSync(jfile, normalise(events));
      expect(normalise(events)).toBe(readFileSync(jfile, 'utf8'));
    });
  }
});
