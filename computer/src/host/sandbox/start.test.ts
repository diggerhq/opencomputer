import type net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunnerSpec, SessionSpec } from '../../protocol.js';
import { createTelemetry } from '../../telemetry/emitter.js';
import type { TelemetryEvent } from '../../telemetry/envelope.js';
import type { ContainerInfo } from './containers.js';
import { sandboxRecords } from './records.js';
import { type SandboxStartDeps, imageTag, sandboxStarts } from './start.js';

const IMAGE = 'ghcr.io/diggerhq/computer-session:64a672bb773b059c82f67c9f52741a0540ca1d1c';
const owner = { dir: 'pat', gitName: 'Pat', gitEmail: 'pat@example.com' };
const spec: SessionSpec = { key: 'C1:1.1', kind: 'thread', owner, title: 't', mode: 'default' };
const sock = { destroyed: false } as net.Socket;

function rig(o: { have?: ContainerInfo[]; fail?: Partial<Record<'create' | 'up' | 'inventory', Error>>; stale?: boolean; dial?: () => Promise<net.Socket | undefined> } = {}) {
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
      up: (id, rs, record) => (ups.push(rs), step(`up ${id} ${record?.key}`, { pid: 5, startMs: 33, tokens: { close: () => void log.push('tokens closed') } })),
      stop: (id) => step(`stop ${id}`, undefined),
      remove: (id) => step(`remove ${id}`, true),
      inventory: () => step('inventory', { containers: o.have ?? [], volumes: [] }),
      stale: async () => !!o.stale,
      unitActive: async () => true,
      diagnose: async () => 'Active: inactive (dead)\n--- podman logs\nboom',
    },
    mint: async (s, id, run) => (log.push(`mint ${id} ${run} sdk=${s.sdkSessionId ?? '-'}`), undefined),
    workspace: (r) => `/data/people/${r.person}/sessions/${r.key}`,
    mkdir: async (dir) => void log.push(`mkdir ${dir}`),
    dial: o.dial ?? (async () => sock),
  };
  const events = async () => (await tm.flush(), sent);
  return { ...sandboxStarts(d), log, ups, records, events, tm };
}
const container = (id: string, over: Partial<ContainerInfo> = {}): ContainerInfo => ({ id, state: 'exited', abi: '2', image: IMAGE, createdAt: 0, ...over });

describe('sandbox start', () => {
  it('a new thread: record, workspace, Create, up; no transcript and no host path go in', async () => {
    const t = rig();
    const s = await t.start({ ...spec, sdkSessionId: 'old', forkPath: '/data/people/pat/sessions/C1-1.1' }, {});
    const id = s.record.id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(t.records.find('pat', 'C1:1.1')).toMatchObject({ id, person: 'pat', key: 'C1:1.1' });
    expect(t.log).toEqual([`mint ${id} /run/sp/sandbox/${id} sdk=-`, 'mkdir /data/people/pat/sessions/C1:1.1', `create ${id}`, `up ${id} C1:1.1`]);
    expect(t.ups[0]).toMatchObject({ id, socket: `/run/sp/sandbox/${id}/runners/${id}.sock`, version: 'v9', session: { key: 'C1:1.1', forkPath: '/workspace' } });
    expect(t.ups[0].session).not.toHaveProperty('sdkSessionId');
    expect(s).toMatchObject({ sock, resumed: false, run: `/run/sp/sandbox/${id}` });
    expect(s.session.sdkSessionId).toBeUndefined();
    const ev = await t.events();
    expect(ev.find((e) => e.event_name === 'runner.launched')).toMatchObject({
      outcome: 'completed', data: { launch_mode: 'podman', image: '64a672bb773b', 'container.create_ms': 11, 'container.start_ms': 33 },
    });
    expect(ev.some((e) => e.event_name === 'runner.ready')).toBe(true);
    expect(t.tm.dropped).toEqual({}); // every key is in the catalog
  });

  it("a thread with a record resumes under the record's id, with its transcript, on its container", async () => {
    const t = rig();
    const first = await t.start(spec, {});
    const id = first.record.id;
    const again = rig({ have: [container(id)] });
    again.records.write(first.record);
    const s = await again.start({ ...spec, sdkSessionId: 'sdk1' }, {});
    expect(s.record.id).toBe(id);
    expect(s.resumed).toBe(true);
    expect(again.log).toEqual([`mint ${id} /run/sp/sandbox/${id} sdk=sdk1`, 'inventory', `up ${id} C1:1.1`]);
    expect(again.ups[0].session).toMatchObject({ sdkSessionId: 'sdk1', forkPath: '/workspace' });
    expect((await again.events()).find((e) => e.event_name === 'runner.launched')?.data).toMatchObject({ 'container.recreated': false });
  });

  const resume = async (o: Parameters<typeof rig>[0], id = 'aaaaaaaaaaaaaaaa') => {
    const t = rig(o);
    t.records.write({ id, person: 'pat', key: 'C1:1.1', createdAt: 'then', usedAt: 'then' });
    const s = await t.start(spec, {});
    return { t, s, id };
  };

  it('a resume recreates the container when there is none, when its ABI differs, and when it is stale', async () => {
    for (const have of [[], [container('aaaaaaaaaaaaaaaa', { abi: '1' })], [container('aaaaaaaaaaaaaaaa', { state: 'running' })]]) {
      const { t, id } = await resume({ have, stale: have[0]?.state === 'running' });
      expect(t.log.slice(1)).toEqual(['inventory', `recreate ${id}`, `up ${id} C1:1.1`]);
      expect((await t.events()).find((e) => e.event_name === 'runner.launched')?.data).toMatchObject({ 'container.recreated': true, 'container.create_ms': 22 });
    }
  });

  it('a resume stops a container that runs with nobody connected, then starts it', async () => {
    const { t, id } = await resume({ have: [container('aaaaaaaaaaaaaaaa', { state: 'running' })] });
    expect(t.log.slice(1)).toEqual(['inventory', `stop ${id}`, `up ${id} C1:1.1`]);
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

  it('shortens the image to its tag', () => {
    expect(imageTag(IMAGE)).toBe('64a672bb773b');
  });
});
