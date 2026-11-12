import type net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunnerSpec, SessionSpec } from '../../protocol.js';
import type { RunnerApi } from '../../protocol-api.js';
import { createTelemetry } from '../../telemetry/emitter.js';
import { containers } from './containers.js';
import { type Exec, asRunner } from './podman.js';
import { sandboxRecords } from './records.js';
import { type SpareDeps, sandboxSpares } from './spares.js';
import { threadLocks } from './thread-lock.js';

const owner = { dir: 'pat', gitName: 'Pat', gitEmail: 'pat@example.com' };
const spec: SessionSpec = { key: 'C1:1.1', kind: 'thread', owner, title: 't', mode: 'default', sdkSessionId: 'old', forkPath: '/data/people/pat/sessions/C1-1.1' };
const sock = { destroyed: false, destroy: () => {} } as unknown as net.Socket;
const tick = () => new Promise((r) => setTimeout(r, 5));

function rig(o: { settleMs?: number; fail?: Partial<Record<'create' | 'up' | 'pid' | 'mount' | 'prepare' | 'mint', Error>>; dial?: () => Promise<net.Socket | undefined>; api?: boolean; stays?: boolean } = {}) {
  const log: string[] = [];
  const ups: { rs: RunnerSpec; record: unknown; mount: unknown }[] = [];
  const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: () => {} });
  const records = sandboxRecords(mkdtempSync(path.join(tmpdir(), 'records-')));
  const runs = mkdtempSync(path.join(tmpdir(), 'run-'));
  const runRoot = (id: string) => path.join(runs, id);
  const step = async <T>(name: string, v: T): Promise<T> => {
    log.push(name.replaceAll(runs, 'RUN'));
    const e = o.fail?.[name.split(' ')[0] as 'create'];
    if (e) throw e;
    return v;
  };
  const locks = threadLocks();
  const d: SpareDeps = {
    tm, records, locks, runRoot, version: 'v9',
    deleteRun: async (id) => (rmSync(runRoot(id), { recursive: true, force: true }), step(`deleteRun ${id}`, true)),
    containers: {
      create: async (id) => (mkdirSync(runRoot(id), { recursive: true }), writeFileSync(path.join(runRoot(id), 'boot.env'), ''), step(`create ${id}`, 11)),
      up: async (id, rs, record, mount) => {
        ups.push({ rs, record, mount });
        return step(`up ${id}`, { pid: 5, startMs: 33, tokens: { close: () => void log.push('tokens closed') } });
      },
      pid: (id) => step(`pid ${id}`, 7),
      remove: (id) => step(`remove ${id}`, !o.stays),
      stop: (id, seconds) => step(`stop ${id} ${seconds}`, undefined),
      diagnose: async () => 'boom',
    },
    mint: async (s, id, run) => (await step(`mint ${id} ${run} sdk=${s.sdkSessionId ?? '-'} fork=${s.forkPath ?? '-'}`, 0), o.api ? ({ journal: '/data/journals/s1/journal.jsonl', token: 'tok' } as RunnerApi) : undefined),
    workspace: {
      repos: () => ['hello'],
      dirs: async (r, names) => void log.push(`dirs ${r.key} ${names.join(',')}`),
      binds: (r, names, journal) => [{ src: `ws:${r.key}`, dst: '/workspace' }, ...names.map((n) => ({ src: n, dst: `/clones/${n}` })), ...(journal ? [{ src: journal, dst: journal }] : [])],
      mount: (id, pid, person, b) => step(`mount ${id} ${pid} ${person} ${b.map((x) => x.dst).join(' ')}`, undefined),
      prepare: async (id, names) => {
        await step(`prepare ${id} ${names.join(',')}`, undefined);
        const record = { ...records.get(id)!, repos: Object.fromEntries(names.map((n) => [n, { branch: 'b', from: 'origin/main', base: 'abc' }])) };
        records.write(record);
        return { record, addMs: 7 };
      },
    },
    dial: o.dial ?? (async () => sock),
    settleMs: o.settleMs ?? 0,
  };
  return { ...sandboxSpares(d), log, ups, records, locks, runRoot, tm };
}

describe('a spare container', () => {
  it('is made with nothing of anyone: no record, no mount, a boot spec with no session and no API', async () => {
    const t = rig();
    const s = await t.launch();
    expect(s.id).toMatch(/^[0-9a-f]{16}$/);
    expect(t.log).toEqual([`create ${s.id}`, `up ${s.id}`]); // no directories of a person, no mint, no mount, no worktree
    expect(t.ups).toEqual([{ rs: { id: s.id, socket: path.join(t.runRoot(s.id), 'runners', `${s.id}.sock`), version: 'v9' }, record: undefined, mount: undefined }]);
    expect(t.records.all()).toEqual([]);
    expect(s).toMatchObject({ sock, run: t.runRoot(s.id), createMs: 11, startMs: 33 });
    expect(t.ids()).toEqual([s.id]);
    expect(t.has(s.id)).toBe(true); // the sweep leaves it alone
    expect(t.tm.dropped).toEqual({});
  });

  it.each(['create', 'up'] as const)('that fails at %s leaves no container and no run directory', async (at) => {
    const t = rig({ fail: { [at]: new Error('boom') } });
    await expect(t.launch()).rejects.toThrow('boom');
    const id = /^create (\w+)/.exec(t.log[0])![1];
    expect(t.log.slice(-2)).toEqual([`remove ${id}`, `deleteRun ${id}`]);
    expect(existsSync(t.runRoot(id))).toBe(false);
    expect(t.ids()).toEqual([]);
  });

  it('whose runner never listens is removed, and its token socket closed', async () => {
    const t = rig({ dial: async () => undefined });
    // pollReady's 30 s: the test only needs the order of what follows it.
    vi.useFakeTimers();
    const p = t.launch().catch((e) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    vi.useRealTimers();
    expect(String(await p)).toMatch(/did not start within 30 s/);
    expect(t.log.filter((l) => /tokens closed|^remove/.test(l))).toEqual(['tokens closed', expect.stringMatching(/^remove /)]);
  });

  it('is bound to one thread: the record under its id, then the mounts with the journal, then the worktrees', async () => {
    const t = rig({ api: true });
    const { id } = await t.launch();
    t.log.length = 0;
    const b = await t.bind(id, spec, {});
    expect(t.log).toEqual([
      'dirs C1:1.1 hello',
      `mint ${id} RUN/${id} sdk=- fork=-`, // a new thread: no transcript, no host path
      `pid ${id}`,
      `mount ${id} 7 pat /workspace /clones/hello /data/journals/s1`,
      `prepare ${id} hello`,
    ]);
    // Until its claim is answered the record says so: whatever is found under this id is not known to be the thread's runner.
    expect(t.records.find('pat', 'C1:1.1')).toMatchObject({ id, person: 'pat', key: 'C1:1.1', repos: { hello: {} }, unclaimed: true });
    expect(b.record.unclaimed).toBe(true);
    expect(t.claimed(id)).not.toHaveProperty('unclaimed');
    expect(t.records.get(id)).not.toHaveProperty('unclaimed');
    expect(t.records.get(id)).toMatchObject({ id, key: 'C1:1.1', repos: { hello: {} } });
    expect(b).toMatchObject({ record: { id, key: 'C1:1.1' }, run: t.runRoot(id), api: { token: 'tok' }, addMs: 7 });
    expect(b.session).not.toHaveProperty('sdkSessionId');
    expect(b.session).not.toHaveProperty('forkPath');
    expect(t.ids()).toEqual([]);
    // Bound once: neither to a second thread, nor a second spare to the same thread.
    await expect(t.bind(id, { ...spec, key: 'C1:2.2' }, {})).rejects.toThrow(/not a spare/);
    const other = await t.launch();
    await expect(t.bind(other.id, spec, {})).rejects.toThrow(/has a sandbox already/);
    expect(t.records.all().map((r) => r.id)).toEqual([id]);
  });

  it('is made a thread\'s in the thread\'s turn, the one a start and a prune take: it waits for whoever has it', async () => {
    const t = rig();
    const { id } = await t.launch();
    t.log.length = 0;
    let end!: () => void;
    const prune = t.locks.run('pat', 'C1:1.1', () => new Promise<void>((r) => (end = r)));
    const claim = t.turn(spec, () => t.bind(id, spec, {}));
    await tick();
    expect(t.log).toEqual([]);
    expect(t.records.all()).toEqual([]);
    end();
    await prune;
    expect((await claim).record.id).toBe(id);
  });

  it('the record is written before anything of the person is mounted', async () => {
    const t = rig({ fail: { mount: new Error('mount refused') } });
    const { id } = await t.launch();
    await expect(t.bind(id, spec, {})).rejects.toThrow('mount refused');
    expect(t.records.get(id)).toMatchObject({ key: 'C1:1.1' });
    expect(t.records.get(id)).not.toHaveProperty('repos');
  });

  it('that could not be bound is removed, and its record and run directory stay for the cold start under the same id', async () => {
    const t = rig({ fail: { prepare: new Error('no worktree') } });
    const { id } = await t.launch();
    await expect(t.bind(id, spec, {})).rejects.toThrow('no worktree');
    t.log.length = 0;
    await t.discard(id);
    expect(t.log).toEqual([`stop ${id} 0`, `remove ${id}`]);
    expect(t.records.find('pat', 'C1:1.1')?.id).toBe(id);
    expect(t.records.get(id)).not.toHaveProperty('unclaimed'); // nothing half-bound is left under the id
    expect(existsSync(t.runRoot(id))).toBe(true);
  });

  it('that could not be removed was stopped with no grace before: nothing of a half-bound spare keeps running, and its record says it was never claimed', async () => {
    const t = rig({ fail: { prepare: new Error('no worktree') }, stays: true });
    const { id } = await t.launch();
    await expect(t.bind(id, spec, {})).rejects.toThrow('no worktree');
    t.log.length = 0;
    await t.discard(id);
    expect(t.log).toEqual([`stop ${id} 0`, `remove ${id}`]);
    expect(t.records.get(id)).toMatchObject({ key: 'C1:1.1', unclaimed: true });
  });

  it('whose connection closed is removed with its run directory; a bound one is its thread\'s and stays', async () => {
    const t = rig();
    const a = await t.launch();
    const b = await t.launch();
    await t.bind(b.id, spec, {});
    t.log.length = 0;
    await Promise.all([t.gone(a.id), t.gone(a.id), t.gone(b.id)]);
    // By container, with no grace: a spare is never waited for, whether or not it heard an `exit`.
    expect(t.log).toEqual([`stop ${a.id} 0`, `remove ${a.id}`, `deleteRun ${a.id}`]); // once
    expect(existsSync(t.runRoot(a.id))).toBe(false);
    expect(existsSync(t.runRoot(b.id))).toBe(true);
  });

  it('the host stops: every spare is stopped and removed by container, the one being made too, and none is made after', async () => {
    let up!: () => void;
    const t = rig({ dial: () => new Promise((r) => (up = () => r(sock))) });
    const a = t.launch();
    await vi.waitFor(() => expect(up).toBeDefined());
    up();
    const { id } = await a;
    const b = t.launch(); // in flight when the host stops
    await vi.waitFor(() => expect(t.ids().length).toBe(2));
    const other = t.ids().find((x) => x !== id)!;
    t.log.length = 0;
    const closed = t.close();
    up();
    await expect(b).rejects.toThrow('the host is stopping');
    await closed;
    expect(t.log.filter((l) => l.startsWith('remove')).sort()).toEqual([`remove ${id}`, `remove ${other}`].sort());
    expect(t.log.filter((l) => l.startsWith('stop')).sort()).toEqual([`stop ${id} 0`, `stop ${other} 0`].sort());
    expect(t.ids()).toEqual([]);
    await expect(t.launch()).rejects.toThrow('the host is stopping');
    expect(t.log.filter((l) => l.startsWith('create'))).toEqual([]);
  });

  it('is not made while a thread starts, and one at a time', async () => {
    const t = rig();
    let done!: () => void;
    const start = t.during(() => new Promise<void>((r) => (done = r)));
    const first = t.launch();
    const second = t.launch();
    await tick();
    expect(t.log).toEqual([]);
    done();
    await start;
    const [a, b] = await Promise.all([first, second]);
    expect(t.log).toEqual([`create ${a.id}`, `up ${a.id}`, `create ${b.id}`, `up ${b.id}`]);
  });

  it('is not made until a while after the last thread start ended', async () => {
    const t = rig({ settleMs: 60 });
    await t.during(async () => {});
    const first = t.launch();
    await tick();
    await t.during(async () => {}); // another thread: the wait starts again
    await new Promise((r) => setTimeout(r, 40));
    expect(t.log).toEqual([]);
    await first;
    expect(t.log).toHaveLength(2);
  });

  it('waits for the image lock before Create', async () => {
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const calls: string[] = [];
    const exec: Exec = (_cmd, args, _o, done) => {
      calls.push(args.slice(args.indexOf('/usr/bin/podman') + 1, args.indexOf('/usr/bin/podman') + 2).join(' '));
      queueMicrotask(() => done(Object.assign(new Error('no podman here'), { code: 125 }), '', 'no podman here'));
      return {};
    };
    const as = asRunner(['sudo'], exec, () => settled);
    const runs = mkdtempSync(path.join(tmpdir(), 'run-'));
    const all = containers({ as, runRoot: (id) => path.join(runs, id), dataDir: '/data', root: '/root', image: 'i:1', abi: '1', start: async () => {}, vars: () => ({}), definition: () => undefined,
      serveTokens: () => ({ close() {} }) });
    const t = rig();
    const spares = sandboxSpares({ tm: t.tm, records: t.records, locks: t.locks, deleteRun: async () => true, containers: all, runRoot: (id) => path.join(runs, id), version: 'v', mint: async () => undefined, workspace: {} as SpareDeps['workspace'] });
    const p = spares.launch().catch((e) => e);
    await tick();
    expect(calls).toEqual([]); // provisioning holds the storage: nothing ran
    settle();
    expect(String(await p)).toMatch(/no podman here/);
    expect(calls[0]).toBe('create');
  });
});
