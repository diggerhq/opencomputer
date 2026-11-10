// The Codex harness against a fake `codex app-server` (testdata/fake-codex.mjs)
// replaying JSON-RPC transcripts recorded from Codex 0.163.0.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Exit, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { close, type GateDecision, type HarnessEvent, type Running, type StartSpec } from '../types.js';
import { codexKind } from './index.js';
import type { Wire } from './app-server.js';

const FAKE = path.join(import.meta.dirname, 'testdata', 'fake-codex.mjs');
const transcript = (name: string) => path.join(import.meta.dirname, 'testdata', `${name}.jsonl`);

let dir: string;
let runs: Running[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'codex-harness-'));
  // The proxy's socket must exist; the loopback connects to it only per request.
  writeFileSync(path.join(dir, 'model.sock'), '');
});
afterEach(() => {
  for (const r of runs) close(r);
  runs = [];
  rmSync(dir, { recursive: true, force: true });
});

interface Started {
  run: Running;
  events: HarnessEvent[];
  /** The stream's end: undefined while it runs, else its exit. */
  end: () => Exit.Exit<void, unknown> | undefined;
  /** Every message the fake received, after its first line (the environment it saw). */
  received: () => Wire[];
  seen: () => Wire;
  until(p: (e: HarnessEvent) => boolean): Promise<void>;
}

/** The fake, behind a launcher that sets its own variables: the child gets only CHILD_ENV of the runner's (config.ts). */
function launcher(vars: Record<string, string>) {
  const bin = path.join(dir, 'codex-bin');
  const exports = Object.entries(vars).map(([k, v]) => `export ${k}=${JSON.stringify(v)}\n`).join('');
  writeFileSync(bin, `#!/bin/sh\n${exports}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function start(name: string, spec: Partial<StartSpec> = {}, env: Record<string, string> = {}, gate?: StartSpec['gate']): Started {
  const logFile = path.join(dir, 'fake.log');
  const kind = codexKind(
    {
      bin: launcher({ FAKE_CODEX_TRANSCRIPT: transcript(name), FAKE_CODEX_LOG: logFile, ...env }),
      socket: path.join(dir, 'model.sock'),
      root: path.join(dir, 'codex'),
      peerCheck: false,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'sk-must-not-pass',
        SLACK_BOT_TOKEN: 'xoxb-no',
        SP_TOKEN_SOCKET: '/run/x/token.sock',
        SP_FILES_SOCKET: '/run/x/r1.files',
        GIT_COMMITTER_NAME: 'Computer',
      },
      envFile: path.join(dir, 'env.sh'),
      defaults: ['gpt-6.1-sol', 'claude-opus-5-5'],
      version: '9.9.9',
    },
    'T1-C1-1.2',
  );
  const run = kind.start({
    cwd: dir,
    mode: 'default',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    speed: 'fast',
    gate: gate ?? (async (): Promise<GateDecision> => ({ behavior: 'deny', message: 'no' })),
    tools: {
      cwd: () => dir,
      hooks: { threads: { read: async () => Promise.reject(new Error('offline')), post: async () => Promise.reject(new Error('offline')) } },
      sendFile: (async () => ({ ok: true })) as Wire,
      postCard: (async () => ({ ok: true })) as Wire,
    },
    ...spec,
  });
  runs.push(run);
  const events: HarnessEvent[] = [];
  let exit: Exit.Exit<void, unknown> | undefined;
  const waiters: (() => void)[] = [];
  Effect.runPromiseExit(
    Stream.runForEach(run.harness.events, (e) =>
      Effect.sync(() => {
        events.push(e);
        for (const w of waiters.splice(0)) w();
      }),
    ),
  ).then((x) => {
    exit = x;
    for (const w of waiters.splice(0)) w();
  });
  const lines = () =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return {
    run,
    events,
    end: () => exit,
    received: () => lines().slice(1),
    seen: () => lines()[0],
    until: (p) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (events.some(p)) return resolve();
          if (exit) return reject(new Error(`stream ended without it: ${JSON.stringify(events.map((e) => e.t))}`));
          waiters.push(check);
        };
        check();
      }),
  };
}

const ready = (s: Started) => Effect.runPromise(s.run.harness.ready);
const send = (s: Started, text: string, how: 'queue' | 'steer' = 'queue') => Effect.runSync(s.run.harness.send({ text, attachments: [] }, how));
const ended = (e: HarnessEvent) => e.t === 'turn_ended';

describe('CodexHarness', () => {
  it('starts a thread on Codex with Calvin tools, a clean environment and its own home, then streams a turn', async () => {
    const s = start('ok');
    await ready(s);
    expect(s.run.harness.startup).toMatchObject({ version: '0.163.0', resumed: false });
    send(s, 'hi');
    await s.until(ended);
    const ts = s.events.filter((e) => e.t !== 'live');
    expect(ts[0]).toMatchObject({ t: 'session', ref: { harness: 'codex', id: '01a16683-9372-75f1-ad73-0677a286fae0' }, model: 'gpt-6.1-sol' });
    expect((ts[0] as Wire).startup).toMatchObject({
      version: expect.any(String),
      spawnMs: expect.any(Number),
      initializeMs: expect.any(Number),
      threadMs: expect.any(Number),
    });
    expect(ts).toContainEqual({ t: 'request', phase: 'start' });
    expect(ts).toContainEqual({ t: 'text', delta: 'Hello from mock' });
    expect(ts.at(-1)).toMatchObject({ t: 'turn_ended', reason: 'done' });

    const env = s.seen().env;
    expect(env).toMatchObject({
      CALVIN_MODEL_KEY: 'ssh-placeholder',
      OPENAI_API_KEY: null,
      SLACK_BOT_TOKEN: null,
      SP_TOKEN_SOCKET: null,
      SP_FILES_SOCKET: '/run/x/r1.files',
      GIT_COMMITTER_NAME: 'Computer',
      HOME: process.env.HOME ?? null,
      BASH_ENV: path.join(dir, 'env.sh'),
    });
    expect(env.CODEX_HOME.startsWith(path.join(dir, 'codex'))).toBe(true);
    expect(existsSync(path.join(env.CODEX_HOME, 'config.toml'))).toBe(true);
    expect(existsSync(path.join(env.CODEX_HOME, 'auth.json'))).toBe(false);
    expect(readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8')).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);

    const got = s.received();
    expect(got[0]).toMatchObject({ method: 'initialize', params: { clientInfo: { name: 'calvin', version: '9.9.9' } } });
    const thread = got.find((m) => m.method === 'thread/start').params;
    expect(thread).toMatchObject({ modelProvider: 'calvin', sandbox: 'danger-full-access', approvalPolicy: 'untrusted', cwd: dir });
    expect(thread.dynamicTools.map((t: Wire) => t.name)).toEqual(expect.arrayContaining(['send_file', 'read_thread', 'post_thread']));
    expect(thread.dynamicTools[0].inputSchema.type).toBe('object');
    expect(got.find((m) => m.method === 'turn/start').params).toMatchObject({
      effort: 'medium',
      serviceTier: 'priority',
      approvalPolicy: 'untrusted',
      summary: 'auto',
      input: [{ type: 'text', text: 'hi' }],
    });
  });

  it("serves Calvin's tools: read_thread runs ungated and its result goes back to Codex", async () => {
    const s = start('tool');
    await ready(s);
    send(s, 'hi');
    await s.until(ended);
    expect(s.events).toContainEqual({
      t: 'tool',
      id: 'call_1',
      name: 'mcp__calvin__read_thread',
      input: { url: 'https://x.slack.com/archives/C1/p1' },
    });
    const reply = s.received().find((m) => m.id === 0 && !m.method);
    expect(reply.result.success).toBe(false);
    expect(reply.result.contentItems[0].text).toContain('could not read the thread: offline');
    expect(s.events.filter(ended)).toHaveLength(1);
  });

  it('a usage limit is a rate limit record and an errored turn', async () => {
    const s = start('limit');
    await ready(s);
    send(s, 'hi');
    await s.until(ended);
    expect(s.events.find((e) => e.t === 'limit')).toMatchObject({ kind: 'rate' });
    expect(s.events.at(-1)).toMatchObject({ t: 'turn_ended', reason: 'error' });
  });

  it('fast only where the model offers it', async () => {
    const s = start('ok', { model: 'gpt-5.5' });
    await ready(s);
    send(s, 'hi');
    await s.until(ended);
    expect(s.received().find((m) => m.method === 'turn/start').params).toMatchObject({ model: 'gpt-5.5', serviceTier: null });
  });

  it('standard speed: no priority tier, even where the model offers it', async () => {
    const s = start('ok', { speed: 'standard' });
    await ready(s);
    send(s, 'hi');
    await s.until(ended);
    expect(s.received().find((m) => m.method === 'turn/start').params).toMatchObject({ model: 'gpt-6.1-sol', serviceTier: null });
  });

  it('a model the endpoint refuses is a model error, once', async () => {
    const s = start('badmodel');
    await ready(s);
    send(s, 'hi');
    await s.until(ended);
    expect(s.events.filter((e) => e.t === 'error')).toEqual([expect.objectContaining({ kind: 'model', code: 'model_not_found' })]);
  });

  it('interrupts a running turn', async () => {
    const s = start('interrupt');
    await ready(s);
    send(s, 'go slow');
    await s.until((e) => e.t === 'request');
    await Effect.runPromise(s.run.harness.interrupt);
    await s.until(ended);
    expect(s.events.at(-1)).toMatchObject({ t: 'turn_ended', reason: 'interrupted' });
  });

  it('an interrupt asked before the turn has an id is sent once it has one', async () => {
    const s = start('interrupt');
    await ready(s);
    send(s, 'go slow');
    await Effect.runPromise(s.run.harness.interrupt);
    await s.until(ended);
    expect(s.received().filter((m) => m.method === 'turn/interrupt')).toHaveLength(1);
    expect(s.events.at(-1)).toMatchObject({ reason: 'interrupted' });
  });

  it('steers into the running turn by its id', async () => {
    const s = start('steer');
    await ready(s);
    send(s, 'go slow');
    await s.until((e) => e.t === 'request');
    await new Promise((r) => setTimeout(r, 50)); // turn/start's result (the turn id) is in by now
    send(s, 'also this', 'steer');
    await s.until(ended);
    const steer = s.received().find((m) => m.method === 'turn/steer');
    expect(steer.params).toMatchObject({ expectedTurnId: '01a16683-f156-7683-ba1f-8113e89982dd', input: [{ text: 'also this' }] });
    expect(s.events.at(-1)).toMatchObject({ reason: 'done' });
  });

  it('queues a second input until the first turn ends', async () => {
    const s = start('ok');
    await ready(s);
    send(s, 'hi');
    send(s, 'again');
    await s.until(ended);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.received().filter((m) => m.method === 'turn/start')).toHaveLength(2);
  });

  it('an app-server that dies mid-turn fails the records once', async () => {
    const s = start('ok', {}, { FAKE_CODEX_EXIT_ON: 'item/agentMessage/delta' });
    await ready(s);
    send(s, 'hi');
    await new Promise<void>((r) => {
      const t = setInterval(() => s.end() && (clearInterval(t), r()), 10);
    });
    const x = s.end()!;
    expect(Exit.isFailure(x) && JSON.stringify(x.cause)).toMatch(/HarnessFailed/);
  });

  it('closing the scope ends the child and the records, without a failure', async () => {
    const s = start('interrupt');
    await ready(s);
    send(s, 'go slow');
    await s.until((e) => e.t === 'request');
    const pid = Number((s.run.harness as Wire).srv.pid);
    close(s.run);
    await new Promise<void>((r) => {
      const t = setInterval(() => s.end() && (clearInterval(t), r()), 10);
    });
    expect(Exit.isSuccess(s.end()!)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('resumes its thread when Codex has it, and starts a new one when not', async () => {
    const lost = start('ok', { resume: 'gone' });
    await ready(lost);
    expect(lost.run.harness.startup?.resumed).toBe(false);
    expect(lost.received().some((m) => m.method === 'thread/start')).toBe(true);

    const kept = start(
      'ok',
      { resume: '01a16683-9372-75f1-ad73-0677a286fae0' },
      { FAKE_CODEX_RESUME: '1', FAKE_CODEX_LOG: path.join(dir, 'kept.log') },
    );
    await ready(kept);
    expect(kept.run.harness.startup?.resumed).toBe(true);
  });

  const bare = (bin: string, socket?: string) => {
    const run = codexKind({ bin, socket, root: dir, peerCheck: false, env: {}, version: '0' }, 'k').start({
      cwd: dir,
      mode: 'default',
      model: 'm',
      effort: 'low',
      speed: 'fast',
      gate: async () => ({ behavior: 'deny', message: '' }),
      tools: { cwd: () => dir, hooks: {}, sendFile: (async () => ({})) as Wire, postCard: (async () => ({})) as Wire },
    });
    runs.push(run);
    return Effect.runPromiseExit(run.harness.ready);
  };

  it('fails ready when Codex is not installed', async () => {
    const s = start('ok');
    expect(Exit.isFailure(await bare(path.join(dir, 'no-codex'), path.join(dir, 'model.sock')))).toBe(true);
    await ready(s);
  });

  it('fails ready, naming the reason, on a computer without the model proxy', async () => {
    for (const socket of [undefined, path.join(dir, 'absent.sock')]) {
      const x = await bare(FAKE, socket);
      expect(Exit.isFailure(x)).toBe(true);
      expect(JSON.stringify(x)).toContain('no model proxy');
    }
  });

  it('lists the models Codex shows, and refuses one it does not serve', async () => {
    const s = start('ok');
    await ready(s);
    expect(await Effect.runPromise(s.run.harness.models)).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ]);
    expect(Exit.isFailure(await Effect.runPromiseExit(s.run.harness.setModel('claude-opus-5-5')))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(s.run.harness.setMode('plan')))).toBe(true);
  });

  it("runs a model Codex does not serve on its default, and says so unless it is Calvin's default", async () => {
    // A Claude model a person picked (/model) is not Calvin's default: they hear it changed.
    for (const model of ['gpt-5.3-codex', 'claude-sonnet-5']) {
      const s = start('ok', { model });
      await s.until((e) => e.t === 'session');
      expect(s.events.find((e) => e.t === 'session')).toMatchObject({ model: 'gpt-6.1-sol', note: expect.stringContaining(model) });
    }
    for (const model of ['gpt-6.1-sol', 'claude-opus-5-5']) {
      const ok = start('ok', { model });
      await ok.until((e) => e.t === 'session');
      expect(ok.events.find((e) => e.t === 'session')).toMatchObject({ model: 'gpt-6.1-sol' });
      expect(ok.events.find((e) => e.t === 'session')).not.toHaveProperty('note');
    }
  });
});
