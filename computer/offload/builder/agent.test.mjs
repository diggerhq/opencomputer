// Runs the real agent as a child process against a local stand-in for S3
// presigned URLs. `npm run test:offload` (part of `npm run check`).

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const AGENT = path.join(import.meta.dirname, 'agent.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-agent-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake S3: GET /src.tgz, PUT /put/<key> (stored), PUT /deny/<key> (403)
const stored = new Map();
let srcTgz;
let s3;
let s3Url;
let agent;
let agentUrl;

before(async () => {
  const src = path.join(tmp, 'srcdir');
  mkdirSync(src);
  writeFileSync(path.join(src, 'hello.txt'), 'hello from the source\n');
  srcTgz = path.join(tmp, 'src.tgz');
  execFileSync('tar', ['-czf', srcTgz, '-C', src, '.']);

  s3 = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.method === 'GET' && req.url === '/src.tgz') return res.end(readFileSync(srcTgz));
    if (req.method === 'PUT' && req.url.startsWith('/put/')) {
      assert.ok(req.headers['content-length'], 'PUT must carry Content-Length');
      stored.set(req.url.slice(5), Buffer.concat(chunks));
      return res.end();
    }
    res.writeHead(req.url.startsWith('/deny/') ? 403 : 404).end();
  });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  s3Url = `http://127.0.0.1:${s3.address().port}`;

  const work = path.join(tmp, 'work');
  mkdirSync(work);
  agent = spawn(process.execPath, [AGENT], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', OC_WORK_ROOT: work, OC_KILL_GRACE_MS: '500', OC_UPLOAD_PATIENCE_MS: '15000' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    agent.stdout.on('data', (c) => {
      const m = /listening on :(\d+)/.exec(String(c));
      if (m) resolve(m[1]);
    });
    agent.on('exit', (code) => reject(new Error(`agent exited ${code}`)));
  });
  agentUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  agent?.kill('SIGTERM');
  await new Promise((r) => s3?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method, p, body) {
  const res = await fetch(agentUrl + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

let n = 0;
function job(over = {}) {
  const id = `job-${++n}`;
  return {
    id,
    cmd: 'true',
    srcUrl: `${s3Url}/src.tgz`,
    outUrl: `${s3Url}/put/${id}.out`,
    logUrl: `${s3Url}/put/${id}.log`,
    artifacts: [],
    timeoutSec: 60,
    ...over,
  };
}

async function waitFor(id, states, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const { json } = await call('GET', `/jobs/${id}`);
    if (states.includes(json.state)) return json;
    if (Date.now() > until) throw new Error(`job ${id} stuck in ${json.state}: ${JSON.stringify(json)}`);
    await sleep(50);
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('GET / describes the machine', async () => {
  const { status, json } = await call('GET', '/');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.arch, process.arch);
  assert.ok(json.cpus >= 1 && json.memGb > 0 && json.agentVersion);
});

test('a build runs, its artifacts upload with a matching sha256, and the log is readable by offset', async () => {
  const j = job({
    cmd: 'cat hello.txt && mkdir -p target/release && printf bin > target/release/app && printf x > target/release/app.d && echo built',
    artifacts: ['target/release/app', 'target/**/*.d'],
  });
  const r = await call('POST', '/jobs', j);
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { id: j.id });
  const done = await waitFor(j.id, ['done', 'failed']);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.exitCode, 0);

  const out = stored.get(`${j.id}.out`);
  assert.equal(done.artifactBytes, out.length);
  assert.equal(done.artifactSha256, createHash('sha256').update(out).digest('hex'));
  const tgz = path.join(tmp, 'got.tgz');
  writeFileSync(tgz, out);
  const names = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(names, ['target/release/app', 'target/release/app.d']);
  assert.ok(done.timings.queuedAt && done.timings.runStartedAt && done.timings.endedAt);

  const log = stored.get(`${j.id}.log`).toString();
  assert.match(log, /hello from the source/);
  assert.match(log, /built/);

  const whole = await call('GET', `/jobs/${j.id}/log?offset=0`);
  assert.equal(whole.text, log);
  assert.equal(whole.headers.get('x-log-offset'), String(Buffer.byteLength(log)));
  const tail = await call('GET', `/jobs/${j.id}/log?offset=6`);
  assert.equal(tail.text, log.slice(6));
  const end = await call('GET', `/jobs/${j.id}/log?offset=${Buffer.byteLength(log)}`);
  assert.equal(end.text, '');
  assert.equal(end.headers.get('x-log-offset'), String(Buffer.byteLength(log)));

  // A retried submit with the same id is accepted and changes nothing.
  assert.equal((await call('POST', '/jobs', j)).status, 202);
});

test('a failing build is failed with its exit code, its log uploaded, and no artifact', async () => {
  const j = job({ cmd: 'echo boom; exit 3', artifacts: ['nothing'] });
  await call('POST', '/jobs', j);
  const s = await waitFor(j.id, ['done', 'failed']);
  assert.equal(s.state, 'failed');
  assert.equal(s.exitCode, 3);
  assert.match(stored.get(`${j.id}.log`).toString(), /boom/);
  assert.equal(stored.has(`${j.id}.out`), false);
});

test('a missing artifact fails the job', async () => {
  const j = job({ artifacts: ['target/none/*.bin'] });
  await call('POST', '/jobs', j);
  const s = await waitFor(j.id, ['done', 'failed']);
  assert.equal(s.state, 'failed');
  assert.match(s.error, /artifact not found/);
});

test('cancel kills the whole process group, background children included', async () => {
  const j = job({ cmd: 'sleep 300 & echo $! > bg.pid; echo started; sleep 300' });
  await call('POST', '/jobs', j);
  await waitFor(j.id, ['running']);
  const pidFile = path.join(tmp, 'work', 'src', 'bg.pid');
  let bg;
  for (let i = 0; i < 100 && !bg; i++, await sleep(50)) {
    try {
      bg = Number(readFileSync(pidFile, 'utf8'));
    } catch {}
  }
  assert.ok(bg && alive(bg));

  // Another job while one runs is refused.
  assert.equal((await call('POST', '/jobs', job())).status, 409);

  const c = await call('POST', `/jobs/${j.id}/cancel`);
  assert.equal(c.status, 200);
  assert.equal(c.json.state, 'cancelled');
  const s = await waitFor(j.id, ['cancelled']);
  assert.equal(s.state, 'cancelled');
  for (let i = 0; i < 40 && alive(bg); i++) await sleep(50);
  assert.equal(alive(bg), false, 'background child survived cancel');
  // The log is still uploaded for a cancelled job.
  for (let i = 0; i < 40 && !stored.has(`${j.id}.log`); i++) await sleep(50);
  assert.match(stored.get(`${j.id}.log`).toString(), /started/);
});

test('timeoutSec kills the build and the job ends in timeout', async () => {
  const j = job({ cmd: 'trap "" TERM; sleep 300', timeoutSec: 1 });
  await call('POST', '/jobs', j);
  const s = await waitFor(j.id, ['timeout', 'failed', 'done'], 10000);
  assert.equal(s.state, 'timeout');
  assert.match(s.error, /timed out/);
});

test('an expired upload URL is retried with the URL from PUT /jobs/:id/urls', async () => {
  const j = job({ cmd: 'printf a > a.out', artifacts: ['a.out'] });
  j.outUrl = `${s3Url}/deny/${j.id}.out`;
  await call('POST', '/jobs', j);
  await waitFor(j.id, ['uploading']);
  const r = await call('PUT', `/jobs/${j.id}/urls`, { outUrl: `${s3Url}/put/${j.id}.out` });
  assert.equal(r.status, 200);
  const s = await waitFor(j.id, ['done', 'failed']);
  assert.equal(s.state, 'done', s.error);
  assert.equal(
    s.artifactSha256,
    createHash('sha256')
      .update(stored.get(`${j.id}.out`))
      .digest('hex'),
  );
});

test('bad requests are refused', async () => {
  assert.equal((await call('POST', '/jobs', job({ artifacts: ['../etc/passwd'] }))).status, 400);
  assert.equal((await call('POST', '/jobs', job({ artifacts: ['/abs'] }))).status, 400);
  assert.equal((await call('POST', '/jobs', job({ id: 'a/b' }))).status, 400);
  assert.equal((await call('POST', '/jobs', job({ timeoutSec: 0 }))).status, 400);
  assert.equal((await call('POST', '/jobs', job({ workdir: '/etc' }))).status, 400);
  assert.equal((await call('POST', '/jobs', job({ srcUrl: 'file:///etc/passwd' }))).status, 400);
  assert.equal((await call('GET', '/jobs/nope')).status, 404);
  assert.equal((await call('PUT', '/jobs/job-1/urls', { outUrl: 'ftp://x' })).status, 400);
});
