import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fence } from '../offload-protocol.js';
import type { Aws } from './aws.js';
import { type Jobs, offloadJobs } from './jobs.js';
import { type Ledger, openLedger } from './ledger.js';

// A fake builder agent (the contract's HTTP API) and a fake AWS: no call leaves this process.
interface FakeJob { body: Record<string, unknown>; state: string; exitCode?: number; log: Buffer; cancelled?: boolean }
const agentJobs = new Map<string, FakeJob>();
let badAuth = 0;
const server = http.createServer((req, res) => {
  if (req.headers['x-aws-proxy-auth'] !== 'tok') return badAuth++, res.writeHead(401).end();
  const u = new URL(req.url!, 'http://x');
  const m = u.pathname.match(/^\/jobs\/([^/]+)(\/log|\/cancel|\/urls)?$/);
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    if (u.pathname === '/') return res.end(JSON.stringify({ ok: true }));
    if (req.method === 'POST' && u.pathname === '/jobs') {
      const b = JSON.parse(body);
      agentJobs.set(b.id, { body: b, state: 'running', log: Buffer.alloc(0) });
      return res.writeHead(202).end('{}');
    }
    const j = m && agentJobs.get(m[1]);
    if (!j) return res.writeHead(404).end();
    if (m[2] === '/log') {
      const off = Number(u.searchParams.get('offset'));
      return res.writeHead(200, { 'X-Log-Offset': String(j.log.length) }).end(j.log.subarray(off));
    }
    if (m[2] === '/cancel') return (j.cancelled = true), (j.state = 'cancelled'), res.end('{}');
    if (m[2] === '/urls') return res.end('{}');
    res.end(JSON.stringify({ id: m[1], state: j.state, exitCode: j.exitCode, ...(j.state === 'done' && { artifactSha256: 'ab'.repeat(32), artifactBytes: 10 }) }));
  });
});
let endpoint = '';
beforeAll(() => new Promise<void>((r) => server.listen(0, '127.0.0.1', () => ((endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`), r()))));
afterAll(() => void server.close());

function fakeAws() {
  const runs: Record<string, unknown>[] = [];
  const terminated: string[] = [];
  const tagged: Record<string, string>[] = [];
  let n = 0;
  const a: Aws = {
    run: async (s) => (runs.push({ ...s }), { microvmId: `mv-${++n}`, endpoint }),
    state: async (id) => (terminated.includes(id) ? 'TERMINATED' : 'RUNNING'),
    tag: async (_id, t) => void tagged.push(t),
    tags: async () => ({}),
    authToken: async () => 'tok',
    terminate: async (id) => void terminated.push(id),
    list: async () => [],
    presignPut: async (k) => `https://s3.test/put/${k}`,
    presignGet: async (k) => `https://s3.test/get/${k}`,
  };
  return { a, runs, terminated, tagged };
}

const F = (o: Partial<Fence> = {}): Fence => ({ org: 'o', sessionKey: 'C1:1.1', runnerId: 'r1', epoch: 10, ...o });
const config = { images: { s: 'img-s' }, maxConcurrent: 1, queueMax: 2, maxMinutes: 60, sourceMaxMb: 10, artifactMaxMb: 10 };
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error('timed out waiting');
};

function setup(o: { now?: () => number } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  const ledger: Ledger = openLedger(dir);
  const aws = fakeAws();
  const jobs: Jobs = offloadJobs({ config, aws: aws.a, ledger, logsDir: path.join(dir, 'logs'), hostTag: 'i-host', pollMs: 10, bootMs: 2000, now: o.now });
  const go = async (f = F(), cmd = 'make') => {
    const { id } = await jobs.submit(f, { size: 's', cmd, sourceBytes: 1, timeoutMin: 5 });
    jobs.start(f, id);
    return id;
  };
  return { jobs, ledger, aws, go };
}

describe('offload jobs', () => {
  it('runs a job to done: launched, tagged, logs pulled, MicroVM terminated', async () => {
    const { jobs, aws, go } = setup();
    const id = await go();
    await until(() => agentJobs.has(id));
    expect(agentJobs.get(id)!.body).toMatchObject({ cmd: 'make', timeoutSec: 300, srcUrl: `https://s3.test/get/runs/i-host/${id}/src.tgz` });
    expect(aws.runs[0]).toMatchObject({ jobId: id, image: 'img-s', minutes: 5, maxMinutes: 60 });
    expect(aws.tagged[0]).toMatchObject({ 'opencomputer:offload': 'i-host', 'opencomputer:job': id });
    agentJobs.get(id)!.log = Buffer.from('hello\n');
    Object.assign(agentJobs.get(id)!, { state: 'done', exitCode: 0 });
    await until(() => jobs.status(F(), id).state === 'done');
    expect(aws.terminated).toEqual(['mv-1']);
    expect(Buffer.from(jobs.logs(F(), id, 0).data, 'base64').toString()).toBe('hello\n');
    expect(jobs.logs(F(), id, 6).eof).toBe(true);
    expect(await jobs.fetch(F(), id)).toMatchObject({ url: `https://s3.test/get/runs/i-host/${id}/out.tgz`, sha256: 'ab'.repeat(32) });
    expect(badAuth).toBe(0);
  });

  it('fences: another session, runner or older epoch is refused; a newer epoch takes over', async () => {
    const { jobs } = setup();
    const { id } = await jobs.submit(F(), { size: 's', cmd: 'x', sourceBytes: 1 });
    expect(() => jobs.status(F({ sessionKey: 'C2:2.2' }), id)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => jobs.status(F({ org: 'other' }), id)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => jobs.cancel(F({ runnerId: 'r2' }), id)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => jobs.status(F({ epoch: 9 }), id)).toThrow(expect.objectContaining({ code: 'stale-fence' }));
    expect(jobs.list(F({ sessionKey: 'C2:2.2' }))).toEqual([]);
    expect(() => jobs.status(undefined, id)).toThrow(expect.objectContaining({ code: 'refused' }));
    jobs.list(F({ runnerId: 'r2', epoch: 11 }));
    expect(() => jobs.status(F(), id)).toThrow(expect.objectContaining({ code: 'stale-fence' }));
    expect(jobs.list(F({ runnerId: 'r2', epoch: 11 }))[0]).toMatchObject({ id, state: 'cancelled' });
  });

  it('caps: one at a time, a FIFO queue, refused past it', async () => {
    const { jobs, go } = setup();
    const a = await go(F(), 'sleep');
    const b = await go();
    const c = await go();
    expect(jobs.counts()).toEqual({ running: 1, queued: 2 });
    expect(jobs.status(F(), c).queuePosition).toBe(2);
    await expect(jobs.submit(F(), { size: 's', cmd: 'x', sourceBytes: 1 })).rejects.toMatchObject({ code: 'over-cap' });
    await expect(jobs.submit(F(), { size: 'm', cmd: 'x', sourceBytes: 1 })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(jobs.submit(F(), { size: 's', cmd: 'x', sourceBytes: 11 * 1024 * 1024 })).rejects.toMatchObject({ code: 'over-cap' });
    await expect(jobs.submit(F(), { size: 's', cmd: 'x', sourceBytes: 1, timeoutMin: 61 })).rejects.toMatchObject({ code: 'over-cap' });
    await until(() => agentJobs.has(a));
    agentJobs.get(a)!.state = 'done';
    await until(() => agentJobs.has(b));
    expect(jobs.status(F(), c).queuePosition).toBe(1);
    expect(jobs.cancelFence(F())).toBe(2);
    await until(() => jobs.counts().running === 0);
    expect(jobs.status(F(), b).state).toBe('cancelled');
    expect(agentJobs.get(b)!.cancelled).toBe(true);
    expect(jobs.status(F(), c).state).toBe('cancelled');
  });

  it('a running job past its deadline is timeout, and its MicroVM terminated', async () => {
    let t = 1_000_000;
    const { jobs, aws, go } = setup({ now: () => t });
    const id = await go();
    await until(() => jobs.status(F(), id).state === 'running');
    t += 3600_000;
    await until(() => jobs.status(F(), id).state === 'timeout');
    expect(aws.terminated).toEqual(['mv-1']);
    expect(agentJobs.get(id)!.cancelled).toBe(true);
  });

  it('cancel stops a running job; drain refuses new work', async () => {
    const { jobs, aws, go } = setup();
    const id = await go();
    await until(() => agentJobs.has(id));
    expect(jobs.cancel(F(), id)).toEqual({ cancelled: true });
    await until(() => jobs.status(F(), id).state === 'cancelled');
    expect(aws.terminated).toEqual(['mv-1']);
    expect(await jobs.drain(1000)).toBe(true);
    await expect(jobs.submit(F(), { size: 's', cmd: 'x', sourceBytes: 1 })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('jobs an earlier process left are failed and their MicroVMs terminated', async () => {
    const { jobs, ledger, aws } = setup();
    ledger.put({ id: 'j0000000000000001', fence: F(), state: 'running', size: 's', cmd: 'x', artifacts: [], minutes: 5, sourceBytes: 1, createdAt: 0, microvmId: 'mv-old' });
    await jobs.recover();
    expect(aws.terminated).toEqual(['mv-old']);
    expect(ledger.get('j0000000000000001')?.state).toBe('failed');
  });
});
