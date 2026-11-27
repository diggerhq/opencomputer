// Offload jobs (work 136): what a session's `oc-offload` asks for through the
// host, and each job's life on its MicroVM.
//
//   submit (source URL) -> session PUTs its tarball -> start -> queued
//   -> launching (row fsynced, RunMicrovm, tag, RUNNING, token, POST /jobs)
//   -> running (agent polled every 5 s, log pulled into the state directory)
//   -> done | failed | cancelled | timeout (MicroVM terminated)
//
// Invariants:
// - Every request names a fence, and a job answers only its own fence, field
//   for field; any other is `not-found` (a session learns nothing of others).
//   A fence older than the newest seen for its session is refused, and the
//   first request of a newer one cancels the older one's jobs.
// - At most `maxConcurrent` MicroVMs; up to `queueMax` jobs wait, first in
//   first out; more, or anything while draining, is refused.
// - A job never outlives its deadline (its minutes, the boot and 2 minutes):
//   past it, it is `timeout` and its MicroVM terminated. A job that leaves
//   `running` by any path has its MicroVM terminated; a terminate that failed
//   leaves a terminal row, which the reaper acts on.
// - A job left non-terminal by an earlier process is failed at start, and its
//   MicroVM terminated: jobs are not taken back.

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { type Fence, type JobState, type JobView, OFFLOAD_SIZES, type OffloadSize, TERMINAL, sameFence, sessionTag } from '../offload-protocol.js';
import { log } from '../log.js';
import { AGENT_TERMINAL, type Agent, type AgentStatus, agentClient } from './agent.js';
import type { Aws } from './aws.js';
import type { OffloadConfig } from './config.js';
import type { JobRow, Ledger } from './ledger.js';

export class Refused extends Error {
  constructor(message: string, readonly code: 'refused' | 'not-found' | 'over-cap' | 'bad-request' | 'stale-fence' | 'unavailable') {
    super(message);
  }
}

export interface JobsDeps {
  config: Pick<OffloadConfig, 'images' | 'imageVersion' | 'maxConcurrent' | 'queueMax' | 'maxMinutes' | 'sourceMaxMb' | 'artifactMaxMb'>;
  aws: Aws;
  ledger: Ledger;
  logsDir: string;
  /** The `opencomputer:offload` tag: which box's MicroVMs these are. */
  hostTag: string;
  agent?: (endpoint: string, token: () => string) => Agent;
  now?: () => number;
  pollMs?: number;
  /** RunMicrovm until the agent answers. */
  bootMs?: number;
  /** True while new jobs are refused but running ones go on (the draining marker). */
  paused?: () => boolean;
}

const MIB = 1024 * 1024;
const LOG_MAX = 32 * MIB;
const LOG_CHUNK = 256 * 1024;
const SUBMITTED_TTL = 15 * 60_000;
const TOKEN_RENEW = 50 * 60_000;
const URL_RESIGN = 10 * 60_000;
const ID = /^j[0-9a-f]{16}$/;

const objectKey = (hostTag: string, id: string, name: 'src.tgz' | 'out.tgz' | 'build.log') => `offload/${hostTag}/${id}/${name}`;
const safeArtifact = (a: unknown) => typeof a === 'string' && a.length > 0 && a.length < 1024 && !a.startsWith('/') && !a.split('/').includes('..');

export function view(r: JobRow, queuePosition?: number): JobView {
  const { id, state, size, cmd, createdAt, startedAt, endedAt, agentState, exitCode, error, artifactSha256, artifactBytes } = r;
  return { id, state, size, cmd, createdAt, startedAt, endedAt, agentState, exitCode, error, artifactSha256, artifactBytes, ...(queuePosition && { queuePosition }) };
}

interface Ctl {
  stop?: { state: JobState; error?: string };
  microvmId?: string;
  agent?: Agent;
  wake?: () => void;
}

export function offloadJobs(d: JobsDeps) {
  const { aws, ledger, config: c } = d;
  const now = d.now ?? Date.now;
  const pollMs = d.pollMs ?? 5000;
  const bootMs = d.bootMs ?? 120_000;
  const mkAgent = d.agent ?? ((e: string, t: () => string) => agentClient(e, t));
  mkdirSync(d.logsDir, { recursive: true, mode: 0o700 });
  const logFile = (id: string) => path.join(d.logsDir, `${id}.log`);
  const queue: string[] = [];
  const active = new Map<string, Ctl>();
  const latest = new Map<string, number>();
  let draining = false;
  const refusing = () => draining || !!d.paused?.();

  const update = (id: string, patch: Partial<JobRow>, sync = false) => {
    const r = { ...ledger.get(id)!, ...patch };
    ledger.put(r, sync);
    return r;
  };

  function cancel(id: string, state: JobState = 'cancelled', error?: string): boolean {
    const r = ledger.get(id);
    if (!r || TERMINAL.has(r.state)) return false;
    const ctl = active.get(id);
    if (ctl) {
      ctl.stop ??= { state, error };
      ctl.wake?.();
      return true;
    }
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    update(id, { state, error, endedAt: now() });
    return true;
  }

  function admit(f: unknown): Fence {
    const x = f as Fence;
    if (!x || typeof x.org !== 'string' || typeof x.sessionKey !== 'string' || !x.sessionKey || typeof x.runnerId !== 'string' || !Number.isSafeInteger(x.epoch))
      throw new Refused('no fence: ask through the host', 'refused');
    const k = `${x.org}\0${x.sessionKey}`;
    const l = latest.get(k);
    if (l !== undefined && x.epoch < l) throw new Refused('this session has moved to another runner', 'stale-fence');
    if (l === undefined || x.epoch > l) {
      latest.set(k, x.epoch);
      for (const r of ledger.all())
        if (!TERMINAL.has(r.state) && r.fence.org === x.org && r.fence.sessionKey === x.sessionKey && r.fence.epoch < x.epoch) cancel(r.id, 'cancelled', 'the session moved to another runner');
    }
    return x;
  }
  function own(f: unknown, id: unknown): JobRow {
    const fence = admit(f);
    const r = typeof id === 'string' && ID.test(id) ? ledger.get(id) : undefined;
    if (!r || !sameFence(r.fence, fence)) throw new Refused('no such job', 'not-found');
    return r;
  }

  async function submit(f: unknown, q: { size?: unknown; cmd?: unknown; artifacts?: unknown; timeoutMin?: unknown; sourceBytes?: unknown }) {
    const fence = admit(f);
    if (refusing()) throw new Refused('offload is draining on this host', 'unavailable');
    const size = q.size as OffloadSize;
    if (!OFFLOAD_SIZES.includes(size) || !c.images[size]) throw new Refused(`size ${String(q.size)} is not offered on this host`, 'bad-request');
    if (typeof q.cmd !== 'string' || !q.cmd.trim() || q.cmd.length > 64 * 1024) throw new Refused('cmd must be a non-empty string', 'bad-request');
    const artifacts = Array.isArray(q.artifacts) ? q.artifacts : [];
    if (artifacts.length > 64 || !artifacts.every(safeArtifact)) throw new Refused('artifacts must be relative paths without ..', 'bad-request');
    const sourceBytes = Number(q.sourceBytes);
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) throw new Refused('sourceBytes must be a byte count', 'bad-request');
    if (sourceBytes > c.sourceMaxMb * MIB) throw new Refused(`source is over ${c.sourceMaxMb} MiB`, 'over-cap');
    const t = q.timeoutMin === undefined ? c.maxMinutes : Number(q.timeoutMin);
    if (!Number.isInteger(t) || t < 1) throw new Refused('timeout must be whole minutes', 'bad-request');
    if (t > c.maxMinutes) throw new Refused(`timeout is over this host's ${c.maxMinutes} minutes`, 'over-cap');
    const waiting = ledger.all().filter((r) => r.state === 'submitted' || r.state === 'queued').length;
    if (waiting >= c.queueMax) throw new Refused(`${waiting} offload jobs are already waiting on this host`, 'over-cap');
    const id = `j${randomBytes(8).toString('hex')}`;
    const srcPutUrl = await aws.presignPut(objectKey(d.hostTag, id, 'src.tgz'));
    ledger.put({ id, fence, state: 'submitted', size, cmd: q.cmd, artifacts: artifacts as string[], minutes: t, sourceBytes, createdAt: now() });
    return { id, srcPutUrl, minutes: t };
  }

  function start(f: unknown, id: unknown) {
    const r = own(f, id);
    if (r.state !== 'submitted') throw new Refused(`job is ${r.state}, not submitted`, 'refused');
    if (refusing()) throw new Refused('offload is draining on this host', 'unavailable');
    update(r.id, { state: 'queued' });
    queue.push(r.id);
    pump();
    return view(ledger.get(r.id)!, positionOf(r.id));
  }

  const positionOf = (id: string) => (queue.indexOf(id) + 1) || undefined;
  function pump() {
    while (!draining && queue.length && active.size < c.maxConcurrent) {
      const id = queue.shift()!;
      void run(id);
    }
  }

  /** Bytes the agent has past `offset`, appended to the job's log (up to LOG_MAX kept); the offset after them. */
  async function pullLog(agent: Agent, id: string, offset: number): Promise<number> {
    for (let i = 0; i < 8; i++) {
      const { data, next } = await agent.log(id, offset);
      if (!data.length) return next;
      const have = (() => { try { return statSync(logFile(id)).size; } catch { return 0; } })();
      if (have < LOG_MAX) appendFileSync(logFile(id), data.subarray(0, LOG_MAX - have), { mode: 0o600 });
      offset = next;
    }
    return offset;
  }

  async function nap(ctl: Ctl, ms: number) {
    await new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      ctl.wake = () => (clearTimeout(t), res());
    });
    ctl.wake = undefined;
  }

  async function run(id: string) {
    const ctl: Ctl = {};
    active.set(id, ctl);
    let final: AgentStatus | undefined;
    try {
      const r = update(id, { state: 'launching', startedAt: now(), deadline: now() + bootMs + (ledger.get(id)!.minutes * 60 + 120) * 1000 }, true);
      const { microvmId, endpoint } = await aws.run({ jobId: id, image: c.images[r.size]!, imageVersion: c.imageVersion, minutes: r.minutes, maxMinutes: c.maxMinutes });
      ctl.microvmId = microvmId;
      update(id, { microvmId });
      aws.tag(microvmId, { 'opencomputer:offload': d.hostTag, 'opencomputer:job': id, 'opencomputer:session': sessionTag(r.fence.sessionKey) })
        .catch((e) => log.warn(`offload ${id}: MicroVM ${microvmId} not tagged: ${e?.message ?? e}`));
      let token = '';
      let tokenAt = 0;
      const agent = (ctl.agent = mkAgent(endpoint, () => token));
      for (const bootEnd = now() + bootMs; ; await nap(ctl, 1000)) {
        if (ctl.stop) return;
        if (now() > bootEnd) throw new Error(`the MicroVM did not come up in ${bootMs / 1000} s`);
        const st = await aws.state(microvmId);
        if (st === 'TERMINATED' || st === 'TERMINATING') throw new Error('the MicroVM ended while starting');
        if (st !== 'RUNNING') continue;
        if (!token) (token = await aws.authToken(microvmId)), (tokenAt = now());
        if ((await agent.info().catch(() => ({ ok: false }))).ok) break;
      }
      const url = (name: 'src.tgz' | 'out.tgz' | 'build.log', put: boolean) => (put ? aws.presignPut : aws.presignGet)(objectKey(d.hostTag, id, name));
      await agent.submit({ id, cmd: r.cmd, artifacts: r.artifacts, timeoutSec: r.minutes * 60,
        srcUrl: await url('src.tgz', false), outUrl: await url('out.tgz', true), logUrl: await url('build.log', true) });
      const { deadline } = update(id, { state: 'running', agentState: 'queued' });
      let offset = 0;
      let signedAt = now();
      let failures = 0;
      for (;;) {
        if (ctl.stop) return;
        if (now() > deadline!) return void (ctl.stop = { state: 'timeout', error: `past its ${r.minutes} minutes` });
        await nap(ctl, pollMs);
        if (ctl.stop) return;
        try {
          if (now() - tokenAt > TOKEN_RENEW) (token = await aws.authToken(microvmId)), (tokenAt = now());
          if (now() - signedAt > URL_RESIGN) await agent.urls(id, { outUrl: await url('out.tgz', true), logUrl: await url('build.log', true) }), (signedAt = now());
          offset = await pullLog(agent, id, offset);
          const s = await agent.status(id);
          failures = 0;
          if (s.state !== ledger.get(id)!.agentState) update(id, { agentState: s.state });
          if (AGENT_TERMINAL.has(s.state)) {
            await pullLog(agent, id, offset).catch(() => {});
            return void (final = s);
          }
        } catch (e) {
          log.warn(`offload ${id}: poll failed: ${(e as Error)?.message ?? e}`);
          if (++failures >= 6) {
            failures = 0;
            const st = await aws.state(microvmId).catch(() => undefined);
            if (st === 'TERMINATED' || st === 'TERMINATING') return void (ctl.stop = { state: 'failed', error: 'the MicroVM ended' });
          }
        }
      }
    } catch (e) {
      ctl.stop ??= { state: 'failed', error: String((e as Error)?.message ?? e) };
    } finally {
      if (!final && ctl.agent && ctl.stop?.state !== 'failed') await ctl.agent.cancel(id).catch(() => {});
      if (ctl.microvmId) await aws.terminate(ctl.microvmId).catch((e) => log.warn(`offload ${id}: MicroVM ${ctl.microvmId} not terminated (the reaper will): ${e?.message ?? e}`));
      update(id, { endedAt: now(), ...(final ? ended(final) : ctl.stop ?? { state: 'failed', error: 'stopped' }) });
      active.delete(id);
      pump();
    }
  }

  function ended(s: AgentStatus): Partial<JobRow> {
    const state: JobState = s.state === 'done' ? 'done' : s.state === 'timeout' ? 'timeout' : s.state === 'cancelled' ? 'cancelled' : 'failed';
    const over = s.artifactBytes !== undefined && s.artifactBytes > c.artifactMaxMb * MIB;
    return { state, agentState: s.state, exitCode: s.exitCode, artifactSha256: s.artifactSha256, artifactBytes: s.artifactBytes,
      error: over ? `artifact is over ${c.artifactMaxMb} MiB` : s.error };
  }

  function logs(f: unknown, id: unknown, offset: unknown) {
    const r = own(f, id);
    const from = Number(offset);
    if (!Number.isSafeInteger(from) || from < 0) throw new Refused('offset must be a byte offset', 'bad-request');
    let data = Buffer.alloc(0);
    let size = 0;
    try {
      size = statSync(logFile(r.id)).size;
      if (from < size) {
        const fd = openSync(logFile(r.id), 'r');
        data = Buffer.alloc(Math.min(LOG_CHUNK, size - from));
        data = data.subarray(0, readSync(fd, data, 0, data.length, from));
        closeSync(fd);
      }
    } catch {}
    const next = from + data.length;
    return { data: data.toString('base64'), next, eof: TERMINAL.has(r.state) && !active.has(r.id) && next >= size };
  }

  async function fetchArtifact(f: unknown, id: unknown) {
    const r = own(f, id);
    if (r.state !== 'done' || !r.artifactSha256) throw new Refused(`job is ${r.state}${r.artifactSha256 ? '' : ' and has no artifact'}`, 'refused');
    if (r.artifactBytes !== undefined && r.artifactBytes > c.artifactMaxMb * MIB) throw new Refused(`artifact is over ${c.artifactMaxMb} MiB`, 'over-cap');
    return { url: await aws.presignGet(objectKey(d.hostTag, r.id, 'out.tgz')), sha256: r.artifactSha256, bytes: r.artifactBytes };
  }

  return {
    submit,
    start,
    status: (f: unknown, id: unknown) => { const r = own(f, id); return view(r, positionOf(r.id)); },
    logs,
    cancel: (f: unknown, id: unknown) => ({ cancelled: cancel(own(f, id).id) }),
    fetch: fetchArtifact,
    list: (f: unknown) => {
      const x = admit(f);
      return ledger.all().filter((r) => r.fence.org === x.org && r.fence.sessionKey === x.sessionKey).map((r) => view(r, positionOf(r.id)));
    },
    /** The host's: every live job of exactly this fence is cancelled. */
    cancelFence: (f: Fence) => ledger.all().filter((r) => sameFence(r.fence, f) && cancel(r.id, 'cancelled', 'the runner went away')).length,
    counts: () => ({ running: active.size, queued: queue.length }),
    get draining() { return draining; },
    /** Submitted jobs whose source never came are failed (their URL is dead after 15 minutes). */
    tick() {
      for (const r of ledger.all()) if (r.state === 'submitted' && now() - r.createdAt > SUBMITTED_TTL) cancel(r.id, 'failed', 'the source was never uploaded');
    },
    /** Jobs an earlier process left: failed, their MicroVMs terminated. */
    async recover() {
      for (const r of ledger.all()) {
        if (TERMINAL.has(r.state) || active.has(r.id)) continue;
        if (r.microvmId) await aws.terminate(r.microvmId).catch((e) => log.warn(`offload ${r.id}: MicroVM ${r.microvmId} not terminated: ${e?.message ?? e}`));
        update(r.id, { state: 'failed', error: 'the offload service restarted', endedAt: now() });
      }
    },
    /** Refuse new work, cancel all, and wait (up to `ms`) for every MicroVM to be terminated. True when all were. */
    async drain(ms: number) {
      draining = true;
      for (const r of ledger.all()) if (!TERMINAL.has(r.state)) cancel(r.id, 'cancelled', 'offload is draining on this host');
      for (const end = now() + ms; active.size && now() < end; ) await new Promise((res) => setTimeout(res, 50));
      return active.size === 0;
    },
  };
}

export type Jobs = ReturnType<typeof offloadJobs>;
