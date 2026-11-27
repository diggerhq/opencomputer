#!/usr/bin/env node
// The build agent inside an offload MicroVM (selfhost/aws/build-offload-image.sh
// bakes it into the image; docs/self-hosting/offload.mdx). oc-offload on the
// host drives it over the MicroVM endpoint, which AWS guards with the
// X-aws-proxy-auth token; the session never sees the endpoint or the token.
//
// Protocol (one job at a time per MicroVM):
//   GET  /                     {ok, arch, cpus, memGb, agentVersion}
//   POST /jobs                 {id, cmd, srcUrl, outUrl, logUrl, artifacts, timeoutSec, workdir?} -> 202 {id}
//   GET  /jobs/:id             {id, state, exitCode?, artifactSha256?, artifactBytes?, error?, timings}
//   GET  /jobs/:id/log?offset= text/plain from offset; X-Log-Offset: next offset
//   POST /jobs/:id/cancel      kills the build's process group; state cancelled
//   PUT  /jobs/:id/urls        {outUrl?, logUrl?} replaces the (re-signed) upload URLs
//
// A job: GET srcUrl (tar.gz) into workdir, `bash -lc cmd` in its own process
// group under timeoutSec, tar the artifacts (paths or globs relative to
// workdir) to out.tgz, PUT it to outUrl with its sha256, PUT the log to logUrl.
// Node stdlib only; tar and bash come from the image.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync, statSync, writeSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const AGENT_VERSION = '1';
const ROOT = path.resolve(process.env.OC_WORK_ROOT || '/work');
const KILL_GRACE_MS = Number(process.env.OC_KILL_GRACE_MS || 10_000);
const UPLOAD_PATIENCE_MS = Number(process.env.OC_UPLOAD_PATIENCE_MS || 10 * 60_000);
const MAX_TIMEOUT_SEC = 8 * 3600;
const LOG_CHUNK = 1 << 20;
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'timeout']);

/** @type {Map<string, any>} */
const jobs = new Map();

const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, body, headers = {}) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': raw ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(raw ? body : JSON.stringify(body));
}

async function readJson(req, max = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const isUrl = (u) => typeof u === 'string' && /^https?:\/\//.test(u);
const safeRel = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0');

function validate(b) {
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(b.id)) return 'id must match [A-Za-z0-9_.-]{1,128}';
  if (typeof b.cmd !== 'string' || !b.cmd.trim()) return 'cmd must be a non-empty string';
  for (const k of ['srcUrl', 'outUrl', 'logUrl']) if (!isUrl(b[k])) return `${k} must be an http(s) URL`;
  if (!Array.isArray(b.artifacts) || !b.artifacts.every(safeRel)) return 'artifacts must be relative paths or globs without ..';
  if (!Number.isInteger(b.timeoutSec) || b.timeoutSec < 1 || b.timeoutSec > MAX_TIMEOUT_SEC) return `timeoutSec must be 1..${MAX_TIMEOUT_SEC}`;
  if (b.workdir !== undefined) {
    const w = typeof b.workdir === 'string' ? path.resolve(b.workdir) : '';
    if (!w.startsWith(ROOT + path.sep)) return `workdir must be under ${ROOT}`;
  }
  return null;
}

function view(j) {
  const out = { id: j.id, state: j.state, timings: j.timings };
  for (const k of ['exitCode', 'artifactSha256', 'artifactBytes', 'error']) if (j[k] !== undefined) out[k] = j[k];
  return out;
}

// Sync, so the agent's notes interleave in order with the build's own output.
function note(j, line) {
  try {
    const fd = openSync(j.logPath, 'a');
    try {
      writeSync(fd, `[oc-offload agent] ${line}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

/** GET url into file. Retries transient failures. */
async function download(j, url, file) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (j.aborted) throw new Error('cancelled');
    try {
      await new Promise((resolve, reject) => {
        const req = (url.startsWith('https:') ? https : http).get(url, { signal: j.abort.signal }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(Object.assign(new Error(`GET source: HTTP ${res.statusCode}`), { status: res.statusCode }));
          }
          pipeline(res, createWriteStream(file)).then(resolve, reject);
        });
        req.on('error', reject);
      });
      return;
    } catch (e) {
      last = e;
      if (j.aborted || (e.status && e.status < 500 && e.status !== 429)) break;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw last;
}

/** PUT file to url with Content-Length (presigned S3 needs it); hashes what it sends. */
function putOnce(url, file) {
  const size = statSync(file).size;
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { method: 'PUT', headers: { 'content-length': size } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, sha256: hash.digest('hex'), bytes: size }));
    });
    req.on('error', reject);
    const src = createReadStream(file);
    src.on('data', (c) => hash.update(c));
    src.on('error', (e) => req.destroy(e));
    src.pipe(req);
  });
}

/** PUT with patience: a 403/400 usually means the URL expired; oc-offload re-signs via PUT /jobs/:id/urls. */
async function upload(j, which, file) {
  const until = now() + UPLOAD_PATIENCE_MS;
  for (let attempt = 0; ; attempt++) {
    const url = j[which];
    let why;
    try {
      const r = await putOnce(url, file);
      if (r.status >= 200 && r.status < 300) return r;
      why = `HTTP ${r.status}`;
    } catch (e) {
      why = e.message;
    }
    if (now() >= until) throw new Error(`PUT ${which}: ${why}`);
    if (which === 'outUrl') note(j, `upload of the artifact failed (${why}); retrying`);
    // Wake early if new URLs arrive.
    await Promise.race([sleep(Math.min(30_000, 1000 * 2 ** attempt)), new Promise((r) => (j.urlsChanged = r))]);
  }
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let err = '';
    p.stderr?.on('data', (c) => (err = (err + c).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {}
}

function stopBuild(j, state) {
  if (TERMINAL.has(j.state)) return;
  j.aborted = state;
  j.state = state;
  if (state === 'timeout') j.error = `timed out after ${j.timeoutSec}s`;
  j.abort.abort();
  if (j.child) {
    killGroup(j.child.pid, 'SIGTERM');
    const pid = j.child.pid;
    setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS).unref();
  }
}

/** Expand artifact patterns in workdir (bash globstar); every pattern must match. NUL-separated list. */
async function listArtifacts(workdir, patterns, listFile) {
  // each() gets one pattern's matches as its arguments (unquoted $p expands the glob, IFS= stops word splitting).
  const script =
    'shopt -s nullglob globstar dotglob; IFS=; cd -- "$1" || exit 2; out=$2; shift 2; : > "$out"\n' +
    'each() { [ $# -gt 0 ] || return 3; for f; do [ -e "$f" ] || return 3; printf "%s\\0" "$f" >> "$out"; done; }\n' +
    'for p in "$@"; do each $p || { echo "artifact not found: $p" >&2; exit 3; }; done';
  await run('bash', ['-c', script, 'list', workdir, listFile, ...patterns], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function runJob(j) {
  const dir = path.join(ROOT, 'jobs', j.id);
  const t = j.timings;
  try {
    j.state = 'downloading';
    t.downloadStartedAt = now();
    await rm(j.workdir, { recursive: true, force: true });
    await mkdir(j.workdir, { recursive: true });
    const srcFile = path.join(dir, 'src.tgz');
    await download(j, j.srcUrl, srcFile);
    if (j.aborted) return;
    await run('tar', ['-xzf', srcFile, '-C', j.workdir, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'], signal: j.abort.signal });
    await rm(srcFile, { force: true });
    if (j.aborted) return;

    j.state = 'running';
    t.runStartedAt = now();
    const logFd = openSync(j.logPath, 'a');
    const exit = await new Promise((resolve) => {
      const child = spawn('bash', ['-lc', j.cmd], {
        cwd: j.workdir,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, OC_OFFLOAD_JOB: j.id },
      });
      j.child = child;
      const timer = setTimeout(() => {
        note(j, `timeout after ${j.timeoutSec}s; killing the build`);
        stopBuild(j, 'timeout');
      }, j.timeoutSec * 1000);
      child.on('error', (e) => resolve({ code: null, error: e.message }));
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    closeSync(logFd);
    // Whatever the build left in its group (daemons, background jobs) goes too.
    killGroup(j.child.pid, 'SIGKILL');
    t.runEndedAt = now();
    if (exit.error) throw new Error(`spawn: ${exit.error}`);
    j.exitCode = exit.code ?? (exit.signal ? 128 + (os.constants.signals[exit.signal] || 0) : -1);
    if (j.aborted) return;

    j.state = 'uploading';
    t.uploadStartedAt = now();
    if (j.exitCode === 0) {
      const listFile = path.join(dir, 'artifacts.list');
      const outFile = path.join(dir, 'out.tgz');
      if (j.artifacts.length) await listArtifacts(j.workdir, j.artifacts, listFile);
      else await (await open(listFile, 'w')).close();
      await run('tar', ['-czf', outFile, '-C', j.workdir, '--null', '-T', listFile], { stdio: ['ignore', 'ignore', 'pipe'] });
      const r = await upload(j, 'outUrl', outFile);
      j.artifactSha256 = r.sha256;
      j.artifactBytes = r.bytes;
    }
    await uploadLog(j);
    j.state = j.exitCode === 0 ? 'done' : 'failed';
    if (j.exitCode !== 0) j.error = `build exited ${j.exitCode}`;
  } catch (e) {
    if (j.aborted) return;
    j.error = String(e.message || e);
    note(j, `failed: ${j.error}`);
    if (!j.logUploaded) await uploadLog(j).catch(() => {});
    j.state = 'failed';
  } finally {
    if (j.aborted) {
      j.state = j.aborted;
      await uploadLog(j).catch(() => {});
    }
    t.endedAt = now();
  }
}

async function uploadLog(j) {
  await upload(j, 'logUrl', j.logPath);
  j.logUploaded = true;
}

async function createJob(b) {
  const j = {
    id: b.id,
    cmd: b.cmd,
    srcUrl: b.srcUrl,
    outUrl: b.outUrl,
    logUrl: b.logUrl,
    artifacts: b.artifacts,
    timeoutSec: b.timeoutSec,
    workdir: b.workdir ? path.resolve(b.workdir) : path.join(ROOT, 'src'),
    state: 'queued',
    timings: { queuedAt: now() },
    abort: new AbortController(),
    logPath: path.join(ROOT, 'jobs', b.id, 'build.log'),
  };
  await mkdir(path.dirname(j.logPath), { recursive: true });
  await (await open(j.logPath, 'a')).close();
  jobs.set(j.id, j);
  runJob(j);
  return j;
}

async function readLog(j, offset) {
  const fh = await open(j.logPath, 'r');
  try {
    const buf = Buffer.alloc(LOG_CHUNK);
    const { bytesRead } = await fh.read(buf, 0, LOG_CHUNK, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://agent');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && parts.length === 0) {
      const memGb = Math.round((os.totalmem() / 2 ** 30) * 10) / 10;
      return send(res, 200, { ok: true, arch: process.arch, cpus: os.availableParallelism(), memGb, agentVersion: AGENT_VERSION });
    }
    if (parts[0] !== 'jobs') return send(res, 404, { error: 'not found' });
    if (req.method === 'POST' && parts.length === 1) {
      const b = await readJson(req);
      const bad = validate(b);
      if (bad) return send(res, 400, { error: bad });
      const same = jobs.get(b.id);
      if (same) return send(res, 202, { id: same.id }); // a retried submit
      const busy = [...jobs.values()].find((j) => !TERMINAL.has(j.state));
      if (busy) return send(res, 409, { error: `job ${busy.id} is ${busy.state}` });
      const j = await createJob(b);
      return send(res, 202, { id: j.id });
    }
    const j = jobs.get(parts[1]);
    if (!j) return send(res, 404, { error: 'no such job' });
    if (req.method === 'GET' && parts.length === 2) return send(res, 200, view(j));
    if (req.method === 'GET' && parts[2] === 'log' && parts.length === 3) {
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const data = await readLog(j, offset);
      return send(res, 200, data, { 'x-log-offset': String(offset + data.length) });
    }
    if (req.method === 'POST' && parts[2] === 'cancel' && parts.length === 3) {
      stopBuild(j, 'cancelled');
      return send(res, 200, view(j));
    }
    if (req.method === 'PUT' && parts[2] === 'urls' && parts.length === 3) {
      const b = await readJson(req);
      for (const k of ['outUrl', 'logUrl']) {
        if (b[k] === undefined) continue;
        if (!isUrl(b[k])) return send(res, 400, { error: `${k} must be an http(s) URL` });
        j[k] = b[k];
      }
      j.urlsChanged?.();
      return send(res, 200, { id: j.id });
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
}

export function start(port = Number(process.env.PORT || 8080), host = process.env.HOST || '0.0.0.0') {
  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

function shutdown() {
  for (const j of jobs.values()) stopBuild(j, 'cancelled');
  setTimeout(() => process.exit(0), 200).unref();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const server = await start();
  console.log(`oc-offload agent ${AGENT_VERSION} listening on :${server.address().port}`);
}
