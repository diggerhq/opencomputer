import type net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log as hostLog } from '../../log.js';
import type { RunnerSpec, SessionSpec } from '../../protocol.js';
import type { RunnerApi } from '../../protocol-api.js';
import { createTelemetry } from '../../telemetry/emitter.js';
import type { TelemetryEvent } from '../../telemetry/envelope.js';
import type { ContainerInfo } from './containers.js';
import { sandboxRecords } from './records.js';
import { type SandboxStartDeps, imageTag, sandboxStarts } from './start.js';

const IMAGE = 'ghcr.io/diggerhq/computer-session:64a672bb773b059c82f67c9f52741a0540ca1d1c';
const owner = { dir: 'pat', gitName: 'Pat', gitEmail: 'pat@example.com' };
const spec: SessionSpec = { key: 'C1:1.1', kind: 'thread', owner, title: 't', mode: 'default' };
const sock = { destroyed: false } as net.Socket;

function rig(o: { have?: ContainerInfo[]; homes?: string[]; fail?: Partial<Record<'create' | 'up' | 'inventory' | 'mount' | 'prepare', Error>>; stale?: boolean;
  dial?: () => Promise<net.Socket | undefined>; definition?: boolean; clones?: string[]; api?: boolean } = {}) {
  const log: string[] = [];
  const ups: RunnerSpec[] = [];
  const sent: TelemetryEvent[] = [];
  const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: (b) => void sent.push(...b.events) });
  const records = sandboxRecords(mkdtempSync(path.join(tmpdir(), 'records-')));
  const step = async <T>(name: string, v: T): Promise<T> => {
    log.push(name);
    const e = o.fail?.[name.split(' ')[0] as 'create'];
    if (e) throw e;
    return v;
  };
  const d: SandboxStartDeps = {
    tm, records, image: IMAGE, abi: '2', version: 'v9',
    runRoot: (id) => `/run/sp/sandbox/${id}`,
    containers: {
      create: (id) => step(`create ${id}`, 11),
      recreate: (id) => step(`recreate ${id}`, 22),
      up: async (id, rs, record, mount) => {
        ups.push(rs);
        const up = await step(`up ${id} ${record?.key}`, { pid: 5, startMs: 33, tokens: { close: () => void log.push('tokens closed') } });
        await mount?.(5);
        return { ...up, mountMs: 4 };
      },
      stop: (id) => step(`stop ${id}`, undefined),
      remove: (id) => step(`remove ${id}`, true),
      inventory: () => step('inventory', { containers: o.have ?? [], volumes: (o.homes ?? []).map((id) => ({ id, createdAt: 0 })) }),
      stale: async () => !!o.stale,
      unitActive: async () => true,
      diagnose: async () => 'Active: inactive (dead)\n--- podman logs\nboom',
    },
    mint: async (s, id, run) => (log.push(`mint ${id} ${run} sdk=${s.sdkSessionId ?? '-'}`), o.api ? ({ journal: '/data/journals/s1/journal.jsonl' } as RunnerApi) : undefined),
    workspaces: () => !!o.definition,
    workspace: {
      repos: (r) => (r.repos ? Object.keys(r.repos) : (o.clones ?? [])),
      dirs: async (r, names) => void log.push(`dirs ${r.key} ${names.join(',')}`),
      binds: (r, names, journal) => [{ src: `ws:${r.key}`, dst: '/workspace' }, ...names.map((n) => ({ src: n, dst: `/clones/${n}` })), ...(journal ? [{ src: journal, dst: journal }] : [])],
      mount: (id, pid, person, b) => step(`mount ${id} ${pid} ${person} ${b.map((x) => x.dst).join(' ')}`, undefined),
      prepare: async (id, names) => {
        await step(`prepare ${id} ${names.join(',')}`, undefined);
        const record = { ...records.get(id)!, repos: Object.fromEntries(names.map((n) => [n, { branch: 'sp/C1-1-1', from: 'origin/main', base: 'abc' }])) };
        records.write(record);
        return { record, addMs: 7 };
      },
    },
    dial: o.dial ?? (async () => sock),
  };
  const events = async () => (await tm.flush(), sent);
  return { ...sandboxStarts(d), log, ups, records, events, tm };
}
const container = (id: string, over: Partial<ContainerInfo> = {}): ContainerInfo => ({ id, state: 'exited', abi: '2', image: IMAGE, createdAt: 0, ...over });

afterEach(() => vi.useRealTimers());

describe('sandbox start', () => {
  it('a new thread: record, workspace, Create, up; no transcript and no host path go in', async () => {
    const t = rig();
    const s = await t.start({ ...spec, sdkSessionId: 'old', forkPath: '/data/people/pat/sessions/C1-1.1' }, {});
    const id = s.record.id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(t.records.find('pat', 'C1:1.1')).toMatchObject({ id, person: 'pat', key: 'C1:1.1' });
    expect(t.log).toEqual(['dirs C1:1.1 ', `mint ${id} /run/sp/sandbox/${id} sdk=-`, `create ${id}`, `up ${id} C1:1.1`, `mount ${id} 5 pat /workspace`]);
    expect(t.ups[0]).toMatchObject({ id, socket: `/run/sp/sandbox/${id}/runners/${id}.sock`, version: 'v9', session: { key: 'C1:1.1', forkPath: '/workspace' } });
    expect(t.ups[0].session).not.toHaveProperty('sdkSessionId');
    expect(s).toMatchObject({ sock, resumed: false, run: `/run/sp/sandbox/${id}` });
    expect(s.session.sdkSessionId).toBeUndefined();
    const ev = await t.events();
    expect(ev.find((e) => e.event_name === 'runner.launched')).toMatchObject({
      outcome: 'completed', data: { launch_mode: 'podman', image: '64a672bb773b', 'container.create_ms': 11, 'container.start_ms': 33, 'container.mount_ms': 4 },
    });
    expect(ev.some((e) => e.event_name === 'runner.ready')).toBe(true);
    expect(t.tm.dropped).toEqual({}); // every key is in the catalog
  });

  it("a thread with a record resumes under the record's id, with its transcript, on its container", async () => {
    const t = rig();
    const first = await t.start(spec, {});
    const id = first.record.id;
    const again = rig({ have: [container(id)], homes: [id] });
    again.records.write(first.record);
    const s = await again.start({ ...spec, sdkSessionId: 'sdk1' }, {});
    expect(s.record.id).toBe(id);
    expect(s.resumed).toBe(true);
    // The workspace directory is made again: the first start may have failed before it was.
    expect(again.log).toEqual(['dirs C1:1.1 ', 'inventory', `mint ${id} /run/sp/sandbox/${id} sdk=sdk1`, `up ${id} C1:1.1`, `mount ${id} 5 pat /workspace`]);
    expect(again.ups[0].session).toMatchObject({ sdkSessionId: 'sdk1', forkPath: '/workspace' });
    expect((await again.events()).find((e) => e.event_name === 'runner.launched')?.data).toMatchObject({ 'container.recreated': false });
  });

  const resume = async (o: Parameters<typeof rig>[0], id = 'aaaaaaaaaaaaaaaa', sent: Partial<SessionSpec> = {}) => {
    const t = rig(o);
    t.records.write({ id, person: 'pat', key: 'C1:1.1', createdAt: 'then', usedAt: 'then' });
    const s = await t.start({ ...spec, ...sent }, {});
    return { t, s, id };
  };

  it('a resume keeps the transcript only when the home was there before this start', async () => {
    const id = 'aaaaaaaaaaaaaaaa';
    // A record alone: the first start's Create failed (and took the home with it), or the volume was removed.
    for (const o of [{ have: [] }, { have: [container(id)] }]) {
      const { t, s } = await resume(o, id, { sdkSessionId: 'sdk1', forkPath: '/data/people/pat/sessions/C1-1.1' });
      expect(t.log).toContain(`mint ${id} /run/sp/sandbox/${id} sdk=-`);
      expect(t.ups[0].session).not.toHaveProperty('sdkSessionId');
      expect(s.session.sdkSessionId).toBeUndefined();
      expect(t.ups[0].session?.forkPath).toBe('/workspace');
    }
    // The home is there and the container is not (an ABI change, a removed container): the transcript is in the home.
    const kept = await resume({ have: [], homes: [id] }, id, { sdkSessionId: 'sdk1' });
    expect(kept.t.ups[0].session).toMatchObject({ sdkSessionId: 'sdk1' });
    // The gateway sent none: none goes in.
    const none = await resume({ have: [container(id)], homes: [id] }, id);
    expect(none.t.ups[0].session).not.toHaveProperty('sdkSessionId');
  });

  it('a resume recreates the container when there is none, when its ABI differs, and when it is stale', async () => {
    for (const have of [[], [container('aaaaaaaaaaaaaaaa', { abi: '1' })], [container('aaaaaaaaaaaaaaaa', { state: 'running' })]]) {
      const { t, id } = await resume({ have, stale: have[0]?.state === 'running' });
      expect(t.log.filter((l) => !/^(mint|dirs|mount)/.test(l))).toEqual(['inventory', `recreate ${id}`, `up ${id} C1:1.1`]);
      expect((await t.events()).find((e) => e.event_name === 'runner.launched')?.data).toMatchObject({ 'container.recreated': true, 'container.create_ms': 22 });
    }
  });

  it('a resume stops a container that runs with nobody connected, then starts it', async () => {
    const { t, id } = await resume({ have: [container('aaaaaaaaaaaaaaaa', { state: 'running' })] });
    expect(t.log.filter((l) => !/^(mint|dirs|mount)/.test(l))).toEqual(['inventory', `stop ${id}`, `up ${id} C1:1.1`]);
  });

  it('a resume marks the record used and keeps what else it says', async () => {
    const { t, id } = await resume({ have: [container('aaaaaaaaaaaaaaaa')] });
    const r = t.records.get(id)!;
    expect(r.createdAt).toBe('then');
    expect(r.usedAt).not.toBe('then');
  });

  it('a failed Create removes what it left and fails the start; the record stays', async () => {
    const t = rig({ fail: { create: new Error('create timed out') } });
    await expect(t.start(spec, {})).rejects.toThrow('create timed out');
    const id = t.records.find('pat', 'C1:1.1')!.id;
    expect(t.log.slice(-2)).toEqual([`create ${id}`, `remove ${id}`]);
    expect((await t.events()).find((e) => e.event_name === 'runner.launched')).toMatchObject({ outcome: 'failed', error_type: 'launch' });
  });

  it('a failed inventory or up fails the start (up cleans up after itself)', async () => {
    await expect(resume({ fail: { inventory: new Error('inventory timed out') } })).rejects.toThrow('inventory timed out');
    const t = rig({ fail: { up: new Error('no pid') } });
    await expect(t.start(spec, {})).rejects.toThrow('no pid');
    expect(t.log.some((l) => l.startsWith('stop'))).toBe(false);
  });

  it('a runner that never listens: the one-line error, the diagnosis in the host log only, the container stopped', async () => {
    vi.useFakeTimers();
    const warned: string[] = [];
    const warn = vi.spyOn(hostLog, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.join(' ')));
    const t = rig({ dial: async () => undefined });
    const p = t.start(spec, {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    const e = await p;
    warn.mockRestore();
    expect(e.message).toBe('runner did not start within 30 s');
    expect(warned.join('\n')).toContain('Active: inactive (dead)\n--- podman logs\nboom');
    expect(t.log.slice(-2)).toEqual([`stop ${t.records.find('pat', 'C1:1.1')!.id}`, 'tokens closed']);
  });

  it('what it started can be abandoned by whoever takes it on: the container stops and its token socket closes', async () => {
    const t = rig();
    const s = await t.start(spec, {});
    await s.abandon();
    expect(t.log.slice(-2)).toEqual([`stop ${s.record.id}`, 'tokens closed']);
  });

  it('a new thread under a definition: its clones and journal mounted, its workspace prepared while the runner boots, the record given its repos', async () => {
    const t = rig({ definition: true, clones: ['alpha', 'beta'], api: true });
    const s = await t.start(spec, { trace_id: 'a'.repeat(32) });
    const id = s.record.id;
    expect(t.log.slice(0, 1)).toEqual(['dirs C1:1.1 alpha,beta']);
    expect(t.log.slice(-2)).toEqual([`mount ${id} 5 pat /workspace /clones/alpha /clones/beta /data/journals/s1`, `prepare ${id} alpha,beta`]);
    expect(Object.keys(s.record.repos ?? {})).toEqual(['alpha', 'beta']);
    expect(t.records.get(id)?.repos).toEqual(s.record.repos);
    const ev = await t.events();
    expect(ev.filter((e) => e.event_name === 'runner.launched')).toHaveLength(1);
    expect(ev.find((e) => e.event_name === 'runner.launched')).toMatchObject({ outcome: 'completed', data: { 'container.mount_ms': 4, 'container.add_ms': 7 } });
    expect(ev.find((e) => e.event_name === 'fork.done')).toMatchObject({ outcome: 'completed', data: { repos: 2 } });
    expect(t.tm.dropped).toEqual({});
  });

  it('a thread whose record has repos is not prepared again, and mounts what its record names', async () => {
    const t = rig({ definition: true, clones: ['alpha', 'beta'], have: [container('aaaaaaaaaaaaaaaa')] });
    t.records.write({ id: 'aaaaaaaaaaaaaaaa', person: 'pat', key: 'C1:1.1', createdAt: 'then', usedAt: 'then', repos: { beta: { branch: 'b', from: 'origin/main', base: 'abc' } } });
    await t.start(spec, {});
    expect(t.log.some((l) => l.startsWith('prepare'))).toBe(false);
    expect(t.log.at(-1)).toBe('mount aaaaaaaaaaaaaaaa 5 pat /workspace /clones/beta');
    expect((await t.events()).some((e) => e.event_name === 'fork.done')).toBe(false);
  });

  it('a record without repos is prepared at its next start: the one before failed', async () => {
    const t = rig({ definition: true, clones: ['alpha'], have: [container('aaaaaaaaaaaaaaaa')] });
    t.records.write({ id: 'aaaaaaaaaaaaaaaa', person: 'pat', key: 'C1:1.1', createdAt: 'then', usedAt: 'then' });
    const s = await t.start(spec, {});
    expect(t.log.at(-1)).toBe('prepare aaaaaaaaaaaaaaaa alpha');
    expect(s.record.repos).toHaveProperty('alpha');
  });

  it('a workspace that could not be prepared fails the start: the container stops, the record keeps no repos', async () => {
    const t = rig({ definition: true, clones: ['alpha'], fail: { prepare: new Error('tar: cannot unpack') } });
    await expect(t.start(spec, {})).rejects.toThrow('tar: cannot unpack');
    const id = t.records.find('pat', 'C1:1.1')!.id;
    expect(t.log.slice(-2)).toEqual([`stop ${id}`, 'tokens closed']);
    expect(t.records.get(id)?.repos).toBeUndefined();
    const ev = await t.events();
    expect(ev.find((e) => e.event_name === 'fork.done')).toMatchObject({ outcome: 'failed', error_type: 'git_worktree' });
    expect(ev.find((e) => e.event_name === 'runner.launched')).toMatchObject({ outcome: 'completed' });
  });

  it('mounts that fail fail the launch', async () => {
    const t = rig({ fail: { mount: new Error('sandbox-mount: refused') } });
    await expect(t.start(spec, {})).rejects.toThrow('sandbox-mount: refused');
    expect((await t.events()).find((e) => e.event_name === 'runner.launched')).toMatchObject({ outcome: 'failed', error_type: 'launch' });
  });

  it('shortens the image to its tag', () => {
    expect(imageTag(IMAGE)).toBe('64a672bb773b');
  });
});
