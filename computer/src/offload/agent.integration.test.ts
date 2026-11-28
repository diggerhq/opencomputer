// The jobs engine against the real builder agent (offload/builder/agent.mjs,
// work 136) spawned as a process, with a fake object store and a fake AWS:
// nothing leaves this machine. Skipped where the agent is not in the tree
// (OC_OFFLOAD_AGENT names one elsewhere).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fence } from '../offload-protocol.js';
import type { Aws } from './aws.js';
import { offloadJobs } from './jobs.js';
import { openLedger } from './ledger.js';

const AGENT = path.resolve(process.env.OC_OFFLOAD_AGENT || 'offload/builder/agent.mjs');
const F: Fence = { org: 'o', sessionKey: 'C1:1.1', runnerId: 'r1', epoch: 1 };
const until = async (ok: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error('timed out waiting');
};

describe.skipIf(!existsSync(AGENT))('offload jobs with the real builder agent', { timeout: 30_000 }, () => {
  const objects = new Map<string, Buffer>();
  let store: http.Server;
  let storeUrl = '';
  let agent: ChildProcess;
  let agentUrl = '';
  const terminated: string[] = [];

  beforeAll(async () => {
    store = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c)).on('end', () => {
        if (req.method === 'PUT') return objects.set(req.url!, Buffer.concat(chunks)), res.end();
        const o = objects.get(req.url!);
        return o ? res.end(o) : res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => store.listen(0, '127.0.0.1', r));
    storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-root-'));
    agent = spawn(process.execPath, [AGENT], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', OC_WORK_ROOT: root, OC_KILL_GRACE_MS: '200' } });
    agentUrl = await new Promise<string>((resolve, reject) => {
      agent.stdout!.on('data', (d) => {
        const m = String(d).match(/listening on :(\d+)/);
        if (m) resolve(`http://127.0.0.1:${m[1]}`);
      });
      agent.on('exit', (c) => reject(new Error(`agent exited ${c}`)));
    });
  });
  afterAll(() => {
    agent?.kill();
    store?.close();
  });

  let n = 0;
  function engine() {
    const aws: Aws = {
      run: async () => ({ microvmId: `mv-${++n}`, endpoint: agentUrl }),
      state: async (id) => (terminated.includes(id) ? 'TERMINATED' : 'RUNNING'),
      authToken: async () => 'tok',
      terminate: async (id) => void terminated.push(id),
      list: async () => [],
      presignPut: async (k) => `${storeUrl}/${k}`,
      presignGet: async (k) => `${storeUrl}/${k}`,
    };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jobs-int-'));
    const config = { images: { s: 'img' }, maxConcurrent: 1, queueMax: 4, maxMinutes: 60, sourceMaxMb: 10, artifactMaxMb: 10 };
    return offloadJobs({ config, aws, ledger: openLedger(dir), logsDir: path.join(dir, 'logs'), hostTag: 'i-h', pollMs: 50, bootMs: 5000 });
  }
  /** Submit `cmd` with a one-file source, upload it as a session would, and start. */
  async function submit(jobs: ReturnType<typeof engine>, cmd: string, artifacts: string[] = []) {
    const src = mkdtempSync(path.join(os.tmpdir(), 'src-'));
    writeFileSync(path.join(src, 'in.txt'), 'hello');
    const tgz = execFileSync('tar', ['-czf', '-', '-C', src, '.']);
    const { id, srcPutUrl } = await jobs.submit(F, { size: 's', cmd, artifacts, sourceBytes: tgz.length, timeoutMin: 1 });
    objects.set(new URL(srcPutUrl).pathname, tgz);
    jobs.start(F, id);
    return id;
  }

  it('runs a build: log streamed, artifact uploaded with its sha256, MicroVM terminated', async () => {
    const jobs = engine();
    const id = await submit(jobs, 'mkdir -p dist && tr a-z A-Z < in.txt > dist/out.txt && echo built', ['dist']);
    await until(() => ['done', 'failed'].includes(jobs.status(F, id).state));
    const job = jobs.status(F, id);
    expect(job).toMatchObject({ state: 'done', exitCode: 0, agentState: 'done' });
    expect(Buffer.from(jobs.logs(F, id, 0).data, 'base64').toString()).toContain('built');
    const out = objects.get(`/runs/i-h/${id}/out.tgz`)!;
    expect(createHash('sha256').update(out).digest('hex')).toBe(job.artifactSha256);
    const x = mkdtempSync(path.join(os.tmpdir(), 'out-'));
    mkdirSync(x, { recursive: true });
    execFileSync('tar', ['-xzf', '-', '-C', x], { input: out });
    expect(execFileSync('cat', [path.join(x, 'dist', 'out.txt')]).toString()).toBe('HELLO');
    expect(objects.has(`/runs/i-h/${id}/build.log`)).toBe(true);
    expect(terminated.at(-1)).toBe(`mv-${n}`);
  });

  it('a failing build is failed with its exit code', async () => {
    const jobs = engine();
    const id = await submit(jobs, 'echo oops; exit 3');
    await until(() => ['done', 'failed'].includes(jobs.status(F, id).state));
    expect(jobs.status(F, id)).toMatchObject({ state: 'failed', exitCode: 3 });
  });

  it('cancel reaches the agent and kills the build', async () => {
    const jobs = engine();
    const id = await submit(jobs, 'sleep 30');
    await until(() => jobs.status(F, id).agentState === 'running');
    jobs.cancel(F, id);
    await until(() => jobs.status(F, id).state === 'cancelled');
    expect((await (await fetch(`${agentUrl}/jobs/${id}`)).json()).state).toBe('cancelled');
    expect(terminated.at(-1)).toBe(`mv-${n}`);
  });
});
