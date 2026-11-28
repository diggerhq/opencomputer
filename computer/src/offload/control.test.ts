import { mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../log.js';
import { type Health, askLine } from '../offload-protocol.js';
import { serveControl } from './control.js';
import type { Jobs } from './jobs.js';
import { Refused } from './jobs.js';

// A chown to a group the service is not in fails (EPERM), even a no-op one.
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  chownSync: () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); },
}));

const health = (ready: boolean) => (): Health => ({
  ready, reason: ready ? undefined : 'not AWS: firmware vendor is Google', draining: false, running: 0, queued: 0,
  maxConcurrent: 2, maxMinutes: 60, sourceMaxMb: 2048, artifactMaxMb: 2048, sizes: ['s'],
});

describe('control socket', () => {
  it('when not ready, only health answers', async () => {
    const sock = path.join(mkdtempSync(path.join(os.tmpdir(), 'ctl-')), 'control.sock');
    const s = serveControl(sock, { health: health(false), drain: async () => true });
    await new Promise((r) => s.once('listening', r));
    expect(await askLine(sock, { op: 'health' })).toMatchObject({ ok: true, ready: false });
    expect(await askLine(sock, { op: 'submit' })).toEqual({ ok: false, error: 'not AWS: firmware vendor is Google', code: 'unavailable' });
    s.close();
  });
  it('answers refusals with their code, and unknown ops as bad requests', async () => {
    const sock = path.join(mkdtempSync(path.join(os.tmpdir(), 'ctl-')), 'control.sock');
    const jobs = { status: () => { throw new Refused('no such job', 'not-found'); }, cancelFence: () => 2 } as unknown as Jobs;
    const s = serveControl(sock, { jobs, health: health(true), drain: async () => true });
    await new Promise((r) => s.once('listening', r));
    expect(await askLine(sock, { op: 'status', id: 'j1' })).toEqual({ ok: false, error: 'no such job', code: 'not-found' });
    expect(await askLine(sock, { op: 'nope' })).toMatchObject({ ok: false, code: 'bad-request' });
    expect(await askLine(sock, { op: 'cancelFence', fence: { org: 'o', sessionKey: 's', runnerId: 'r', epoch: 1 } })).toEqual({ ok: true, cancelled: 2 });
    s.close();
  });
  it('leaves the group alone where it is already the host\'s, so a non-member does not chown', async () => {
    const sock = path.join(mkdtempSync(path.join(os.tmpdir(), 'ctl-')), 'control.sock');
    const warn = vi.spyOn(log, 'warn');
    const gid = statSync(path.dirname(sock)).gid;
    const s = serveControl(sock, { health: health(false), drain: async () => true }, gid);
    await new Promise((r) => s.once('listening', r));
    await new Promise((r) => setImmediate(r));
    expect(statSync(sock).mode & 0o777).toBe(0o660);
    expect(warn).not.toHaveBeenCalled();
    s.close();
    const other = path.join(mkdtempSync(path.join(os.tmpdir(), 'ctl-')), 'control.sock');
    const s2 = serveControl(other, { health: health(false), drain: async () => true }, gid + 1);
    await new Promise((r) => s2.once('listening', r));
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not give it group/));
    warn.mockRestore();
    s2.close();
  });
});
