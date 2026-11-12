import { describe, expect, it } from 'vitest';
import { createTelemetry } from '../../telemetry/emitter.js';
import type { TelemetryEvent } from '../../telemetry/envelope.js';
import { ScriptError } from '../../workspaces/script-runner.js';
import { type AsRunner, PodmanError, type RunOptions } from './podman.js';
import { HELPER_SECONDS, sandboxScripts } from './scripts.js';

const ID = '00aa11bb22cc33dd';
const BIN = '/opt/slack-presence/releases/r1/bin';

function rig(answer: () => string | Error = () => 'out') {
  const execs: { id: string; argv: string[]; o: { dir: string; timeoutMs: number; stdin?: string | Buffer } }[] = [];
  const runs: { argv: string[]; o: RunOptions }[] = [];
  const sent: TelemetryEvent[] = [];
  const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: (b) => void sent.push(...b.events) });
  const reply = async () => {
    const a = answer();
    if (a instanceof Error) throw a;
    return a;
  };
  const as: AsRunner = { run: (argv, o) => (runs.push({ argv, o }), reply()), podman: () => reply() };
  const s = sandboxScripts({
    as, tm, root: '/opt/slack-presence/releases/r1', dataDir: '/data', helperRun: '/run/sp/helper', image: 'img:1',
    execIn: (id, argv, o) => (execs.push({ id, argv, o }), reply()),
  });
  return { s, execs, runs, tm, events: async () => (await tm.flush(), sent) };
}

describe('workspace scripts in containers (work 103, C12)', () => {
  it('a session script runs in the thread\'s container, ended there by timeout, the host waiting a little longer', async () => {
    const t = rig();
    const sc = t.s.sessionScripts(ID);
    expect([sc.clones, sc.workspace('ignored')]).toEqual(['/clones', '/workspace']);
    expect(await sc.run('ws-add.sh', ['/clones', '/workspace', 'sp/k', '1', 'alpha'], { timeoutMs: 60_000, stdin: 'tar' })).toBe('out');
    expect(t.execs).toEqual([{
      id: ID,
      argv: ['/usr/bin/timeout', '--kill-after=5', '60', '/bin/sh', `${BIN}/ws-add.sh`, '/clones', '/workspace', 'sp/k', '1', 'alpha'],
      o: { dir: '/', timeoutMs: 75_000, stdin: 'tar' },
    }]);
  });

  it('only a workspace script of the release is run', async () => {
    const t = rig();
    for (const bad of ['../x.sh', 'ws-add.sh; rm', 'sandbox-mount.py', '/bin/sh']) {
      await expect(t.s.sessionScripts(ID).run(bad, [], { timeoutMs: 1000 })).rejects.toThrow('not a workspace script');
    }
    await expect(t.s.helperScripts('pat').run('ws-add.sh', [], { timeoutMs: 1000 })).rejects.toThrow('does not run in a helper container');
    expect([t.execs, t.runs]).toEqual([[], []]);
  });

  it('a helper is a container of its own in a scope, never longer than the table says, with a network only to fetch', async () => {
    const t = rig();
    await t.s.helperScripts('pat').run('ws-clone.sh', ['/clones', 'alpha', 'https://x/a.git', '', ''], { timeoutMs: 1_800_000 });
    await t.s.helperScripts('pat', [{ src: '/data/people/pat/sessions/k', dst: '/workspace', ro: true }]).run('ws-inspect.sh', ['--only=state', '/clones', '/workspace', 'alpha'], { timeoutMs: 5_000, stdin: '1\tx\n' });
    const [clone, inspect] = t.runs;
    expect(clone.argv.slice(0, 3)).toEqual(['/usr/bin/systemd-run', '--user', '--scope']);
    expect(clone.argv).toEqual(expect.arrayContaining(['/usr/bin/podman', 'run', '--rm', '--network=pasta', '--timeout', String(HELPER_SECONDS['ws-clone.sh']), '/data/people/pat/ws:/clones']));
    expect(clone.argv).not.toContain('--interactive');
    expect(clone.argv.slice(-6)).toEqual([`${BIN}/ws-clone.sh`, '/clones', 'alpha', 'https://x/a.git', '', '']);
    expect(clone.o.timeoutMs).toBe(615_000);
    expect(inspect.argv).toEqual(expect.arrayContaining(['--network=none', '--interactive', '--timeout', '5', '/data/people/pat/sessions/k:/workspace:ro']));
    expect(inspect.o).toEqual({ timeoutMs: 20_000, stdin: '1\tx\n' });
    const events = (await t.events()).filter((e) => e.event_name === 'sandbox.helper');
    expect(events.map((e) => [e.data?.script, e.outcome])).toEqual([['ws-clone.sh', 'completed'], ['ws-inspect.sh', 'completed']]);
    expect(t.tm.dropped).toEqual({});
  });

  it('a failure is a ScriptError with the script\'s own words; one that ran out of time says so', async () => {
    const said = rig(() => new PodmanError('failed', 1, 'alpha: no remote branch\n', false));
    const e1 = await said.s.sessionScripts(ID).run('ws-add.sh', [], { timeoutMs: 60_000 }).catch((e) => e);
    expect(e1).toBeInstanceOf(ScriptError);
    expect([e1.killed, e1.message]).toEqual([false, expect.stringContaining('no remote branch')]);
    for (const err of [new PodmanError('failed', 124, '', false), new PodmanError('failed', undefined, '', true)]) {
      const late = rig(() => err);
      const e2 = await late.s.helperScripts('pat').run('ws-sync.sh', [], { timeoutMs: 0 }).catch((e) => e);
      expect([e2.killed, e2.message, e2.stderr]).toEqual([true, 'ws-sync.sh: timed out', 'timed out after 120 s']);
      expect((await late.events()).filter((e) => e.event_name === 'sandbox.helper').map((e) => [e.outcome, e.error_type])).toEqual([['failed', 'timeout']]);
    }
  });
});
