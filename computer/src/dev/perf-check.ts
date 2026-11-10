// Did Slack get slower? (work 084 instrumentation, Q1; the CI answer, the
// production one being K1-K6 split by turn.started's host_protocol / api /
// api_clients). Runs the same Slack turns through a real Session (scripted
// harness, a Slack client that answers at once, real timers) three ways:
//   base:    no API (a v3 host): the Session as it always ran;
//   journal: the runner writes the journal (SessionApi's tap) and serves the
//            API socket, with the host's mirror subscribed over it;
//   client:  the same plus one API client attached with deltas (what the wire
//            relay subscribes for an opc), reading every frame.
// A turn runs tools with outputs of the sizes real ones have (a file read, a
// git log, a grep) holding the session's secrets, which the journal redacts.
// Per turn it measures what Slack sees: the time from the turn's first text
// delta to the Slack call showing it (firstTextMs), and from the harness's end
// of turn to the Session going idle with its final Slack call made (endMs),
// and the process CPU the turn took (cpuMs: the journal's and the subscribers'
// own cost). It fails (exit 1) when, against base:
//   - a mode's p50 firstTextMs or endMs is over FACTOR x base's (a base p50
//     under 2 ms counts as 2 ms, so sub-millisecond noise cannot fail it);
//   - a mode's p50 cpuMs is over CPU_FACTOR x base's plus CPU_FLOOR_MS;
//   - resuming a session with a long journal (perf-resume.ts, --resume-mb):
//     the claim's p50 is over CLAIM_FACTOR x the same claim's on a journal
//     of a few turns plus CLAIM_FLOOR_MS (the load must not grow with history).
// It also reports, ungated, the turn's in-process wall time (the Slack message
// to idle, the stream fed one event per tick).
//   npx tsx src/dev/perf-check.ts [--turns 40] [--factor 1.5] [--resume-mb 64] [--json]

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dialApi, serveApi } from '../api/socket.js';
import { SessionLog } from '../api/session-log.js';
import type { HarnessEvent } from '../runner/harness/types.js';
import type { JournalEvent } from '../protocol.js';
import { SessionApi } from '../runner/api/api.js';
import { done, fakeSession, first, result, text, thinking, tool } from '../runner/api/testing.js';
import { SessionSecrets } from '../runner/session-secrets.js';
import { resumeClaim } from './perf-resume.js';

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const TURNS = arg('turns', 40);
const WARMUP = 3;
const FACTOR = arg('factor', 1.5);
const FLOOR_MS = 2;
const CPU_FACTOR = 2;
const CPU_FLOOR_MS = 4;
const RESUME_MB = arg('resume-mb', 64);
const CLAIMS = 5;
const CLAIM_FACTOR = 3;
const CLAIM_FLOOR_MS = 30;
const JSON_OUT = process.argv.includes('--json');

type Mode = 'base' | 'journal' | 'client';
interface Sample {
  wallMs: number;
  firstTextMs: number;
  endMs: number;
  cpuMs: number;
}

/** The session's secrets, as the host hands them to the runner; the tools' outputs leak some. */
const SECRETS = Array.from({ length: 12 }, (_, i) => ({ name: `PERF_SECRET_${i}`, value: `ghp_perf${i}${'k'.repeat(28)}`, scope: 'user' as const }));
const secretsDir = mkdtempSync(path.join(tmpdir(), 'perf-secrets-'));
const secrets = new SessionSecrets(path.join(secretsDir, 's'));
secrets.apply(SECRETS);
const redact = (s: string) => secrets.redact(s);

/** Lines of `bytes` in all, every 50th holding a secret. */
const output = (bytes: number, line: (i: number) => string) => {
  const out: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const l = i % 50 === 49 ? `${line(i)} token=${SECRETS[i % SECRETS.length].value}` : line(i);
    out.push(l);
    n += l.length + 1;
  }
  return out.join('\n');
};
const READ = output(40_000, (i) => `${String(i + 1).padStart(6)}\t  const value${i} = compute(input, options, ${i}); // keep in step with the schema`);
const GIT_LOG = output(8_000, (i) => `${(i * 2654435761).toString(16).padStart(8, '0').slice(0, 7)} fix(${i % 7 ? 'api' : 'host'}): a change that ships ${i}`);
const GREP = output(3_000, (i) => `src/module${i % 13}/file${i}.ts:${i * 7}:  if (session.status === 'running') return;`);

/** One turn's stream, as the harness streams it: thinking, DELTAS text deltas, three tools and their results, DELTAS more, the end. */
const DELTAS = 100;
function turn(n: number): { head: HarnessEvent[]; text: HarnessEvent[]; rest: HarnessEvent[] } {
  const words = Array.from({ length: DELTAS }, (_, i) => `word${i} `);
  return {
    head: [{ t: 'request', phase: 'start' }, first(), ...thinking(`th${n}`, 'considering the question')],
    text: text(`a${n}`, ...words),
    rest: [
      ...tool(`tu_${n}r`, 'Read', { file_path: '/work/src/module/file.ts' }),
      result(`tu_${n}r`, READ),
      ...tool(`tu_${n}g`, 'Bash', { command: 'git log --oneline -200', description: 'Recent commits' }),
      result(`tu_${n}g`, GIT_LOG),
      ...tool(`tu_${n}s`, 'Grep', { pattern: "status === 'running'", path: 'src' }),
      result(`tu_${n}s`, GREP),
      first(1500),
      ...text(`b${n}`, ...words),
      { t: 'request', phase: 'end' },
      done(),
    ],
  };
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('perf-check: timed out waiting for the session');
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** The mode's samples, and (journal modes) the events the run journaled. */
async function run(mode: Mode): Promise<{ samples: Sample[]; events: JournalEvent[] }> {
  const rec: unknown[] = [];
  const t = fakeSession(rec, { fresh: true });
  const dir = mkdtempSync(path.join(tmpdir(), 'perf-check-'));
  const closers: (() => Promise<unknown> | void)[] = [() => rmSync(dir, { recursive: true, force: true })];
  let journaled = (): JournalEvent[] => [];
  if (mode !== 'base') {
    const sessionId = 'cs_perfcheck0000000';
    const log = await SessionLog.open(path.join(dir, `${sessionId}.jsonl`), {
      sessionId, epoch: 1, lastSeq: 0, redact, seed: { sessionId, owner: { id: 'usr_ann', name: 'Ann', email: null } },
    });
    journaled = () => log.journal.read(0, Number.MAX_SAFE_INTEGER);
    const api = new SessionApi(log, t.sess, { owner: { slackUserId: 'U1', userId: 'usr_ann', name: 'Ann' } as never, suspend: () => {} });
    const socket = path.join(dir, 'api.sock');
    const server = await serveApi(socket, api, { token: 'tok' });
    const sub = async (mirror: boolean) => {
      const c = await dialApi(socket, 'tok');
      await c.subscribe({ deltas: true, mirror, onEvent: (e) => mirror && c.ack(e.seq), onDelta: () => {}, onDetached: () => {} });
      closers.unshift(() => c.close());
    };
    await sub(true);
    if (mode === 'client') await sub(false);
    closers.unshift(() => server.close(), () => api.close());
  }
  const busyEnds = () => rec.filter((r) => (r as { busy?: boolean }).busy === false).length;
  const slackCalls = () => rec.filter((r) => (r as { slack?: string }).slack).length;
  const samples: Sample[] = [];
  for (let n = 0; n < WARMUP + TURNS; n++) {
    const ends = busyEnds();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    const sent = t.sess.send(`question ${n}`, 'U1', [], true);
    await until(() => !!t.h);
    if (n === 0) t.h.push({ t: 'session', ref: { harness: 'claude', id: 'sdk-1' }, model: 'claude-opus-4-5' });
    const { head, text: a, rest } = turn(n);
    for (const e of head) t.h.push(e), await tick();
    const before = slackCalls();
    const ta = performance.now();
    let firstTextMs = -1;
    let te = 0;
    for (const e of [...a, ...rest]) {
      if (e.t === 'turn_ended') te = performance.now();
      t.h.push(e);
      await tick();
      if (firstTextMs < 0 && slackCalls() > before) firstTextMs = performance.now() - ta;
    }
    await sent;
    await until(() => busyEnds() > ends);
    const end = performance.now();
    const wallMs = end - t0;
    const endMs = end - te;
    if (firstTextMs < 0) firstTextMs = wallMs;
    const cpu = process.cpuUsage(cpu0);
    if (n >= WARMUP) samples.push({ wallMs, firstTextMs, endMs, cpuMs: (cpu.user + cpu.system) / 1000 });
  }
  t.sess.kill?.();
  const events = journaled();
  for (const c of closers) await c();
  return { samples, events };
}

const p = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const KEYS = ['firstTextMs', 'endMs', 'wallMs', 'cpuMs'] as const;
const GATED = ['firstTextMs', 'endMs'] as const;
const summary = (s: Sample[]) => Object.fromEntries(KEYS.flatMap((k) => [[`${k}_p50`, p(s.map((x) => x[k]), 0.5)], [`${k}_p95`, p(s.map((x) => x[k]), 0.95)]]));

const results: Record<Mode, Record<string, number>> = {} as never;
let turns: JournalEvent[] = [];
for (const mode of ['base', 'journal', 'client'] as const) {
  const r = await run(mode);
  results[mode] = summary(r.samples);
  if (mode === 'journal') turns = r.events.filter((e) => e.turnId);
}
const resume = await resumeClaim(turns, { bytes: RESUME_MB * 2 ** 20, claims: CLAIMS, redact });
rmSync(secretsDir, { recursive: true, force: true });

const failures: string[] = [];
for (const mode of ['journal', 'client'] as const) {
  for (const k of GATED) {
    const base = results.base[`${k}_p50`];
    const limit = Math.max(base, FLOOR_MS) * FACTOR;
    if (results[mode][`${k}_p50`] > limit) failures.push(`${mode} ${k} p50 ${results[mode][`${k}_p50`].toFixed(2)} > ${FACTOR} x base (${base.toFixed(2)})`);
  }
  const cpu = results[mode].cpuMs_p50;
  const cpuLimit = results.base.cpuMs_p50 * CPU_FACTOR + CPU_FLOOR_MS;
  if (cpu > cpuLimit) failures.push(`${mode} cpuMs p50 ${cpu.toFixed(2)} > ${CPU_FACTOR} x base + ${CPU_FLOOR_MS} (${cpuLimit.toFixed(2)})`);
}
const claimLimit = resume.smallClaimMs * CLAIM_FACTOR + CLAIM_FLOOR_MS;
if (resume.claimMs > claimLimit)
  failures.push(`resume claim p50 ${resume.claimMs.toFixed(1)} ms on ${(resume.bytes / 2 ** 20).toFixed(0)} MiB > ${CLAIM_FACTOR} x a few turns' + ${CLAIM_FLOOR_MS} (${claimLimit.toFixed(1)})`);

if (JSON_OUT) console.log(JSON.stringify({ turns: TURNS, factor: FACTOR, results, resume, failures }));
else {
  console.log(`perf-check: ${TURNS} turns per mode, gate: ${GATED.join(', ')} p50 <= ${FACTOR} x base, cpuMs p50 <= ${CPU_FACTOR} x base + ${CPU_FLOOR_MS}`);
  for (const [mode, r] of Object.entries(results))
    console.log(`  ${mode.padEnd(8)} ${KEYS.map((k) => `${k} p50 ${r[`${k}_p50`].toFixed(2)} p95 ${r[`${k}_p95`].toFixed(2)}`).join('  ')}`);
  console.log(`  resume   claim p50 ${resume.claimMs.toFixed(1)} ms on ${(resume.bytes / 2 ** 20).toFixed(0)} MiB, ${resume.smallClaimMs.toFixed(1)} ms on ${turns.length} events`);
  console.log(failures.length ? `FAIL\n  ${failures.join('\n  ')}` : 'ok');
}
process.exit(failures.length ? 1 : 0);
