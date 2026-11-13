import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createTelemetry } from '../../telemetry/emitter.js';
import type { TelemetryEvent } from '../../telemetry/envelope.js';
import { ScriptError } from '../../workspaces/script-runner.js';
import { type AsRunner, PodmanError, type RunOptions } from './podman.js';
import { Unavailable, UPDATING } from '../unavailable.js';
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
  const podmans: string[][] = [];
  /** What the thread is when a `/files` script enters it, and how often one entered and left. */
  const state = { running: true, held: false, entered: 0, left: 0, order: [] as string[] };
  const as: AsRunner = {
    settled: async () => void state.order.push('settled'),
    run: (argv, o) => (state.order.push('run'), runs.push({ argv, o }), reply()),
    podman: (args) => (podmans.push(args), reply()),
  };
  const started: string[][] = [];
  const children: EventEmitter[] = [];
  const s = sandboxScripts({
    as, sudo: ['/usr/bin/sudo', '-n', '-u', 'agent'], tm, root: '/opt/slack-presence/releases/r1', dataDir: '/data', helperRun: '/run/sp/helper', image: 'img:1',
    execIn: (id, argv, o) => (execs.push({ id, argv, o }), reply()),
    running: async () => state.running, lostWaitMs: 1,
    enter: async (id) => {
      if (state.held) throw new Unavailable(UPDATING);
      state.entered += 1;
      let left = false;
      return { place: { id, person: 'pat', workspace: '/data/people/pat/sessions/k', running: state.running }, leave: () => void (left || ((left = true), (state.left += 1))) };
    },
    spawn: (cmd, args) => {
      started.push([cmd, ...args]);
      const child = Object.assign(new EventEmitter(), { kill: () => true });
      children.push(child);
      return child as ChildProcess;
    },
  });
  return { s, state, execs, runs, podmans, started, children, tm, events: async () => (await tm.flush(), sent) };
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
    // A clone has the caller's limit, 30 min for itself and for each setup command, and no cap of its own.
    await t.s.helperScripts('pat').run('ws-clone.sh', ['/clones', 'alpha', 'https://x/a.git', '', ''], { timeoutMs: 3 * 1_800_000 });
    await t.s.helperScripts('pat', [{ src: '/data/people/pat/sessions/k', dst: '/workspace', ro: true }]).run('ws-inspect.sh', ['--only=state', '/clones', '/workspace', 'alpha'], { timeoutMs: 5_000, stdin: '1\tx\n' });
    const [clone, inspect] = t.runs;
    expect(clone.argv.slice(0, 3)).toEqual(['/usr/bin/systemd-run', '--user', '--scope']);
    expect(clone.argv).toEqual(expect.arrayContaining(['/usr/bin/podman', 'run', '--rm', '--network=pasta', '--timeout', '5400', '/data/people/pat/ws:/clones']));
    expect(clone.argv).not.toContain('--interactive');
    expect(clone.argv.slice(-6)).toEqual([`${BIN}/ws-clone.sh`, '/clones', 'alpha', 'https://x/a.git', '', '']);
    expect(clone.o.timeoutMs).toBe(5_415_000);
    expect(HELPER_SECONDS['ws-sync.sh']).toBe(120);
    expect(inspect.argv).toEqual(expect.arrayContaining(['--network=none', '--interactive', '--timeout', '5', '/data/people/pat/sessions/k:/workspace:ro']));
    expect(inspect.o).toEqual({ timeoutMs: 20_000, stdin: '1\tx\n' });
    // A helper is `podman run` outside `as.podman`: it waits for the image lock by itself, as long as any Podman call.
    expect(t.state.order).toEqual(['settled', 'run', 'settled', 'run']);
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

  it('a helper Podman ended at its --timeout (exit 255, no word) ran out of time; the same exit sooner did not', async () => {
    const quick = rig(() => new PodmanError('failed', 255, '', false));
    const e1 = await quick.s.helperScripts('pat').run('ws-sync.sh', [], { timeoutMs: 0 }).catch((e) => e);
    expect(e1.killed).toBe(false);
    const real = Date.now;
    let t = real();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (t += 130_000));
    try {
      const slow = rig(() => new PodmanError('failed', 255, '', false));
      const e2 = await slow.s.helperScripts('pat').run('ws-sync.sh', [], { timeoutMs: 0 }).catch((e) => e);
      expect([e2.killed, e2.stderr]).toEqual([true, 'timed out after 120 s']);
    } finally {
      now.mockRestore();
    }
  });

  describe('where the /files scripts of a thread run (C13)', () => {
    const sb = { id: ID, person: 'pat', workspace: '/data/people/pat/sessions/k', running: true };
    const AS = ['/usr/bin/sudo', '-n', '-u', 'agent', '--', '/usr/bin/timeout', '--kill-after=2'];

    it('a running thread: podman exec in its container, as the session, in /workspace, ended there by timeout', async () => {
      const t = rig();
      const place = t.s.filesPlace(sb);
      expect(place.root).toBe('/workspace');
      await place.spawn(['/bin/sh', '-c', 'x', 'sh', '/workspace'], { seconds: 30 });
      await place.spawn(['/bin/sh', '-c', 'x'], { stdin: true, write: true });
      const tag = t.started[0].at(-6)?.slice('OPC_FILES='.length);
      expect(tag).toMatch(/^[0-9a-f]{16}$/);
      expect(t.started[0]).toEqual([
        ...AS, '45.000', '/usr/bin/podman', 'exec', '--user', '1500:1500', '--workdir', '/workspace', `sp-runner-${ID}`,
        '/usr/bin/timeout', '--kill-after=5', '30', '/usr/bin/env', `OPC_FILES=${tag}`, '/bin/sh', '-c', 'x', 'sh', '/workspace',
      ]);
      expect(t.started[1].slice(7, 11)).toEqual(['3615.000', '/usr/bin/podman', 'exec', '--interactive']);
      expect(t.started[1].slice(-8, -5)).toEqual(['/usr/bin/timeout', '--kill-after=5', '3600']);
      expect(t.started[1].slice(-3)).toEqual(['/bin/sh', '-c', 'x']);
      expect(t.started[1].at(-4)).not.toBe(`OPC_FILES=${tag}`);
      expect([t.execs, t.runs]).toEqual([[], []]);
    });

    it('a stopped thread: the same helper as a workspace script, its workspace bound read-only unless the script writes, never a network', async () => {
      const t = rig();
      t.state.running = false;
      const place = t.s.filesPlace(sb);
      await place.spawn(['/bin/sh', '-c', 'x', 'sh', '/workspace'], { seconds: 30 });
      await place.spawn(['/bin/sh', '-c', 'x'], { write: true, stdin: true });
      const [read, write] = t.started;
      expect(read.slice(0, 18)).toEqual([...AS, '45.000', '/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--slice=slack-presence-runners.slice', '-p', 'Delegate=yes', '--', '/usr/bin/podman', 'run']);
      expect(read).toEqual(expect.arrayContaining(['--network=none', '--timeout', '30', '--log-driver=none', '/data/people/pat/ws:/clones', `${sb.workspace}:/workspace:ro`]));
      expect(read).not.toContain('--interactive');
      expect(read).not.toContain(`sp-runner-${ID}`);
      expect(read.slice(-7)).toEqual(['--entrypoint', '/bin/sh', 'img:1', '-c', 'x', 'sh', '/workspace']);
      expect(write).toEqual(expect.arrayContaining(['--network=none', '--interactive', '--timeout', '3600', `${sb.workspace}:/workspace`]));
      // A script's own exit is an answer; an exit of timeout(1) or of Podman is the helper's failure.
      t.children[0].emit('close', 3);
      t.children[1].emit('close', 125);
      expect((await t.events()).filter((e) => e.event_name === 'sandbox.helper').map((e) => [e.data?.script, e.outcome])).toEqual([['files', 'completed'], ['files', 'failed']]);
      expect(t.tm.dropped).toEqual({});
    });

    it('a running thread: a script whose command was ended, not over by itself, is ended in the container too', async () => {
      const t = rig();
      const place = t.s.filesPlace(sb);
      const ps = await Promise.all([0, 1, 2, 3, 4].map(() => place.spawn(['/bin/sh', '-c', 'x'], {})));
      const tags = t.started.map((a) => a.at(-4)?.slice('OPC_FILES='.length));
      // The script's own exits: nothing of it is left. Ended by a signal, by timeout(1), or never started: its timeout in the container is told to end it.
      t.children[0].emit('close', 0);
      t.children[1].emit('close', 3);
      t.children[2].emit('close', null);
      t.children[2].emit('close', null);
      t.children[3].emit('close', 124);
      // `podman exec` that is told to end exits 0 (measured, Podman 4.9.3): being told is what counts, not the code.
      expect(ps[4].kill('SIGTERM')).toBe(true);
      t.children[4].emit('close', 0);
      expect(t.podmans).toEqual([2, 3, 4].map((i) => ['exec', '--user', '1500:1500', `sp-runner-${ID}`, 'pkill', '-TERM', '-f', `^/usr/bin/timeout .* OPC_FILES=${tags[i]} `]));
      const pattern = new RegExp(t.podmans[0].at(-1) as string);
      expect(pattern.test(t.started[2].slice(-8).join(' '))).toBe(true);
      expect(pattern.test(t.started[3].slice(-8).join(' '))).toBe(false);
      // What it runs (env has become the shell) is not what is signalled: timeout(1) ends its whole group.
      expect(pattern.test('/bin/sh -c x')).toBe(false);
    });

    it('a stopped thread: a helper whose command was ended, not over by itself, is stopped', async () => {
      const t = rig();
      t.state.running = false;
      const place = t.s.filesPlace(sb);
      const ps = await Promise.all([0, 1, 2, 3].map(() => place.spawn(['/bin/sh', '-c', 'x'], {})));
      const names = t.started.map((a) => a[a.indexOf('--name') + 1]);
      expect(names[0]).toMatch(/^sp-files-[0-9a-f]{16}$/);
      expect(new Set(names).size).toBe(4);
      t.children[0].emit('close', 1);
      t.children[1].emit('close', null);
      t.children[2].emit('close', 143);
      ps[3].kill();
      t.children[3].emit('close', 0);
      expect(t.podmans).toEqual([1, 2, 3].map((i) => ['stop', '--ignore', '--time', '2', names[i]]));
    });

    it('a place that fails to end what is left says so and goes on', async () => {
      const t = rig(() => new PodmanError('failed', 125, 'no such container', false));
      await t.s.filesPlace(sb).spawn(['/bin/sh', '-c', 'x'], {});
      t.children[0].emit('close', null);
      await new Promise((r) => setImmediate(r));
      expect(t.podmans.length).toBe(1);
    });

    it('only a shell script is started', async () => {
      const t = rig();
      await expect(t.s.filesPlace(sb).spawn(['/usr/bin/git', 'status'], {})).rejects.toThrow('not a shell script');
      expect(t.started).toEqual([]);
    });

    it('where it runs is what the thread is when the script starts, whatever its caller was told before', async () => {
      const t = rig();
      const place = t.s.filesPlace({ ...sb, running: false }); // what the request knew
      await place.spawn(['/bin/sh', '-c', 'x'], {});
      t.state.running = false; // idle stop
      await place.spawn(['/bin/sh', '-c', 'x'], {});
      expect(t.started.map((a) => a[a.indexOf('/usr/bin/podman') + 1])).toEqual(['exec', 'run']);
    });

    it('lost: a script in the container whose command failed, untold, and whose container is no longer running then', async () => {
      const t = rig();
      const place = t.s.filesPlace(sb);
      const ps = await Promise.all([0, 1, 2, 3, 4].map(() => place.spawn(['/bin/sh', '-c', 'x'], {})));
      t.state.running = false; // the idle stop
      t.children[0].emit('close', 137); // killed with its container
      t.children[1].emit('close', 255); // `podman exec` found the container stopped
      t.children[2].emit('close', 44); // the script's own answer
      ps[3].kill('SIGTERM'); // the host ended it
      t.children[3].emit('close', 137);
      expect(await Promise.all(ps.map((p) => place.lost?.(p)))).toEqual([true, true, false, false, false]); // the last has not closed
      // A helper is nobody's container to stop: its failure is its own.
      const helper = await place.spawn(['/bin/sh', '-c', 'x'], {});
      t.children[5].emit('close', 255);
      expect(await place.lost?.(helper)).toBe(false);
      // The container still runs: whatever ended the script, it was not the stop.
      const up = rig();
      const p = await up.s.filesPlace(sb).spawn(['/bin/sh', '-c', 'x'], {});
      up.children[0].emit('close', 137);
      expect(await up.s.filesPlace(sb).lost?.(p)).toBe(false);
    });

    it('while provisioning holds the image lock nothing is started, and the caller is told the computer is updating', async () => {
      const t = rig();
      t.state.held = true;
      await expect(t.s.filesPlace(sb).spawn(['/bin/sh', '-c', 'x'], {})).rejects.toThrow(/The computer is updating, try again/);
      expect([t.started, t.podmans]).toEqual([[], []]);
    });

    it('a script has left its sandbox once its command closed, or never started', async () => {
      const t = rig();
      await t.s.filesPlace(sb).spawn(['/bin/sh', '-c', 'x'], {});
      expect([t.state.entered, t.state.left]).toEqual([1, 0]);
      t.children[0].emit('close', 0);
      expect(t.state.left).toBe(1);
      await t.s.filesPlace(sb).spawn(['/bin/sh', '-c', 'x'], {});
      t.children[1].emit('error', new Error('spawn ENOENT'));
      t.children[1].emit('close', null);
      expect([t.state.entered, t.state.left]).toEqual([2, 2]);
    });
  });
});
