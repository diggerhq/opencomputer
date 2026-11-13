// The part of sandbox-check.ts about spares (work 103, step 10; `--spares`):
// containers a `podman` host makes ahead of time, and a new thread's claim of
// one. sandbox-check.ts owns the fake gateway, the collector, the threads and
// the cleanup; this file starts and stops the hosts, asks and compares, and
// prints the timings.
//
// Four hosts, one after the other, on the same directories:
//   A  SP_POOL_SIZE=0: the first reply of new threads without a spare, with a
//      repository and without (the numbers to compare with).
//   B  SP_POOL_SIZE=2: what an unclaimed spare holds (mounts, environment,
//      boot.env, token socket) and costs (its cgroup), the claim (whose
//      container, what is mounted, the timings), the pool's size and refill, a
//      warm delivery beside a refill, new threads back to back, and a claim
//      that fails (the spares are paused): the delivery is answered by a cold
//      start under the record's id. Killed, as a crash: its spares keep running.
//   C  another SP_VERSION and another name for the image: the spares of B are
//      removed at its start and never claimed (and, where the image lock's file is there
//      and the check may read it, not before the lock it holds for LOCK_S is
//      free, nor is a spare made), a thread's container is left alone, the new
//      spare is from the new release and image, and it stays through the idle
//      time that stops the thread it sits beside. Stopped with SIGTERM while
//      the spare's runner is frozen (SIGSTOP), so it can heed no request: the
//      host removes the spare's container, home and run directory itself,
//      and ends within its stop time.
//   D  SP_POOL_SIZE=0: finds nothing left of C's spare, and makes none.
//
// Invariants:
// - A first reply is measured only while nothing else starts: the pool is
//   full (or off) before each, and the threads of a batch are removed after it.
// - A spare is read by its id, found as a run directory below this check's
//   SP_RUN with no record and a running container; a ready one has a Claude
//   Code parked in it.
// - What it adds to the runners' user's Podman besides containers is one more
//   name for the session image, which it removes.

import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { IMAGE_LOCK } from '../host/sandbox/image-lock.js';
import { containerName, pidArgs, unitName, volumeName } from '../host/sandbox/podman-args.js';
import type { Records } from '../host/sandbox/records.js';
import { sandboxRunFor } from '../ipc.js';
import type { HostToGateway, Person, SessionSpec, TraceContext } from '../protocol.js';
import type { TelemetryEvent } from '../telemetry/envelope.js';

export interface SpareThread {
  key: string;
  spec: SessionSpec;
  id(): string;
  deliver(trace?: TraceContext, text?: string): Promise<{ reply?: { ok?: boolean; error?: string }; ms: number; trace: TraceContext }>;
  inspect(format: string): Promise<string>;
  inside(script: string, as?: string): Promise<string>;
  logs(): Promise<string>;
  askToken(): Promise<string>;
}

export interface SpareKit {
  run: string;
  data: string;
  image: string;
  idleMs: number;
  say(...a: unknown[]): void;
  check(ok: boolean, what: string): void;
  until<T>(f: () => T | undefined | Promise<T | undefined>, ms?: number, every?: number): Promise<T | undefined>;
  sleep(ms: number): Promise<unknown>;
  /** Podman as the runners' user. */
  podman(args: string[], timeoutMs?: number): Promise<string>;
  events: HostToGateway[];
  tel: TelemetryEvent[];
  /** The session keys the gateway was asked a token for. */
  tokenSessions: (string | undefined)[];
  mkTrace(): TraceContext;
  people: [Person, Person];
  records(): Records;
  clone(p: Person, name: string): string;
  thread(owner: Person, n: number): SpareThread;
  /** What the gateway's welcome carries from now on, sent to a connected host at once. */
  welcome(about: string, repos: boolean): void;
  start(env: Record<string, string>): ChildProcess;
}

const N = Number(process.env.SP_CHECK_N ?? 6);
const POOL = 2;
const NEXT_VERSION = 'sandbox-check-next';
const NEXT_IMAGE = 'localhost/sandbox-check-spares:next';
const HEX = /^[0-9a-f]{16}$/;
const LOCK_S = 6;

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const p50 = (xs: number[]) => sorted(xs)[Math.floor((xs.length - 1) / 2)] ?? NaN;
const row = (xs: number[]) => `p50 ${p50(xs)} ms, min ${Math.min(...xs)}, max ${Math.max(...xs)}, n=${xs.length} [${xs.join(' ')}]`;
const num = (v: unknown) => (typeof v === 'number' ? v : NaN);

export async function spareChecks(k: SpareKit) {
  const { say, check, until, sleep, podman } = k;
  const [PAT] = k.people;
  let n = 100;
  let host: ChildProcess | undefined;
  const newThread = () => k.thread(PAT, n++);

  // ---- hosts
  async function boot(name: string, env: Record<string, string>) {
    const from = k.events.length;
    const at = Date.now();
    host = k.start(env);
    const hello = await until(() => k.events.slice(from).find((e) => e.t === 'hello'), 60_000);
    check(!!hello, `host ${name} (${Object.entries(env).map(([a, b]) => `${a}=${b}`).join(' ')}) said hello in ${Date.now() - at} ms`);
    if (!hello) throw new Error(`host ${name} did not start: nothing more can be checked`);
    return at;
  }
  async function halt(signal: 'SIGTERM' | 'SIGKILL') {
    const h = host;
    if (!h || h.exitCode !== null || h.signalCode) return;
    const gone = new Promise((r) => h.once('exit', r));
    h.kill(signal);
    await Promise.race([gone, sleep(15_000).then(() => h.kill('SIGKILL'))]);
    await gone;
  }

  // ---- containers, by id
  const status = (id: string) => podman(['inspect', '--format', '{{.State.Status}}', containerName(id)]).then((s) => s.trim(), () => 'none');
  const inside = (id: string, script: string) =>
    podman(['exec', '--user', '1500:1500', containerName(id), '/bin/sh', '-c', script], 60_000).then((s) => s.trim(), (e) => `error: ${String(e?.stderr || e?.message).trim()}`);
  const running = async () => new Set((await podman(['ps', '--format', '{{.Names}}'])).split('\n'));
  /** The spares: run directories of this check's SP_RUN with no record and a running container. */
  async function spares(): Promise<string[]> {
    const up = await running();
    const records = k.records();
    let ids: string[] = [];
    try {
      ids = readdirSync(path.join(k.run, 'sandbox'));
    } catch {
      // no container yet
    }
    return ids.filter((id) => HEX.test(id) && !records.get(id) && up.has(containerName(id)));
  }
  /** Parked: a Claude Code runs beside the runner. */
  const parked = async (id: string) => /claude/i.test(await podman(['top', containerName(id), 'args']).catch(() => ''));
  async function ready(): Promise<string[]> {
    const out: string[] = [];
    for (const id of await spares()) if (await parked(id)) out.push(id);
    return out;
  }
  /** Exactly `count` spares, all parked, and still so a moment later (nothing is starting). */
  async function full(count: number, ms = 90_000): Promise<string[]> {
    const got = await until(async () => {
      const a = await ready();
      if (a.length !== count || (await spares()).length !== count) return;
      await sleep(700);
      const b = await ready();
      return b.length === count && b.every((id) => a.includes(id)) ? b : undefined;
    }, ms);
    return got ?? [];
  }
  const ev = (trace: TraceContext, name: string) => k.tel.find((e) => e.trace_id === trace.id && e.event_name === name);
  const evLater = (trace: TraceContext, name: string) => until(() => ev(trace, name), 10_000);
  const started = () => k.tel.filter((e) => e.event_name === 'pool.spare_started');
  /** Remove the containers of measured threads, so that a batch does not run beside the last one's. */
  async function drop(ts: SpareThread[]) {
    for (const t of ts) if (t.id()) await podman(['rm', '--force', '--volumes', containerName(t.id())], 60_000).catch(() => {});
  }
  /** A unit's cgroup, from the container's first process. */
  async function cgroup(id: string) {
    const pid = Number((await podman(pidArgs(id))).trim());
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').at(-1) ?? '';
    const unit = unitName(id);
    const dir = path.join('/sys/fs/cgroup', line.split('::')[1].split(unit)[0], unit);
    const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
    const stat = Object.fromEntries(read('memory.stat').trim().split('\n').map((l) => l.split(' ')));
    const mb = (v: unknown) => Math.round(Number(v) / 2 ** 20);
    const cpuUs = Number(/usage_usec (\d+)/.exec(read('cpu.stat'))?.[1]);
    return { memory: mb(read('memory.current')), anon: mb(stat.anon), file: mb(stat.file), pids: Number(read('pids.current')), cpuUs };
  }

  /** `count` new threads, one at a time, each once the pool is as `pool` says: the first reply, and the host's own timings. */
  async function batch(what: string, count: number, pool: number) {
    const rows = { reply: [] as number[], host: [] as number[], mount: [] as number[], add: [] as number[], create: [] as number[], start: [] as number[], claim: [] as number[] };
    const ts: SpareThread[] = [];
    let claimed = 0;
    for (let i = 0; i < count; i++) {
      if (pool) await full(pool);
      const t = newThread();
      ts.push(t);
      const d = await t.deliver();
      if (!d.reply?.ok) {
        check(false, `${what}: delivery ${i} failed: ${d.reply?.error}`);
        continue;
      }
      const c = pool ? await evLater(d.trace, 'runner.claimed') : undefined;
      const e = c ?? (await evLater(d.trace, 'runner.launched'));
      if (c) claimed++;
      rows.reply.push(d.ms);
      rows.host.push(num(e?.duration_ms));
      rows.mount.push(num(e?.data?.['container.mount_ms']));
      rows.add.push(num(e?.data?.['container.add_ms']));
      if (c) rows.claim.push(num(c.data?.['container.claim_ms']));
      if (!c) rows.create.push(num(e?.data?.['container.create_ms'])), rows.start.push(num(e?.data?.['container.start_ms']));
    }
    say(`TIMING ${what}: first reply ${row(rows.reply)}`);
    say(`TIMING ${what}: ${pool ? 'runner.claimed' : 'runner.launched'} ${row(rows.host)}; mounts ${row(rows.mount)}; worktrees and root files ${row(rows.add)}${rows.create.length ? `; create ${row(rows.create)}; start ${row(rows.start)}` : ''}`);
    if (pool) say(`TIMING ${what}: the claim frame ${row(rows.claim)}; the rest (record, directories, root files, credentials) ${row(rows.host.map((h, i) => h - rows.mount[i] - rows.add[i] - rows.claim[i]))}`);
    check(claimed === (pool ? count : 0), `${what}: ${claimed} of ${count} took a spare`);
    return { ts, rows };
  }

  // ==== host A: no spares
  await boot('A', { SP_POOL_SIZE: '0', SP_IDLE_MS: '600000' });
  const cloneAt = Date.now();
  const clones = k.people.map((p) => path.join(k.clone(p, 'hello'), '.git', 'worktrees'));
  check(!!(await until(() => (clones.every((c) => existsSync(c)) ? true : undefined), 180_000)), `the repository is cloned for both people (${Date.now() - cloneAt} ms)`);
  await sleep(2000); // the workspace is marked prepared after its clones
  const coldRepos = await batch('no spare, 1 repository', N, 0);
  check((await spares()).length === 0 && started().length === 0, 'SP_POOL_SIZE=0: no spare was made');
  await drop(coldRepos.ts);
  k.welcome('no repositories', false);
  await sleep(1500);
  const coldNone = await batch('no spare, no repository', N, 0);
  await drop(coldNone.ts);
  await halt('SIGTERM');

  // ==== host B: two spares
  k.welcome('with a repository', true);
  const bootAt = await boot('B', { SP_POOL_SIZE: String(POOL), SP_IDLE_MS: '600000' });
  const first = await full(POOL, 120_000);
  check(first.length === POOL, `SP_POOL_SIZE=${POOL}: ${first.length} spares parked ${Date.now() - bootAt} ms after the host started (${first.join(', ')})`);
  if (first.length !== POOL) throw new Error('no spares: nothing more can be checked');
  await until(() => (started().length >= POOL ? true : undefined), 10_000);
  say(`TIMING a spare: ${started().map((e) => `create ${e.data?.['container.create_ms']} ms, start ${e.data?.['container.start_ms']} ms`).join('; ')}`);
  check(started().length === POOL && started().every((e) => e.data?.launch_mode === 'podman' && typeof e.data.image === 'string'), `pool.spare_started: ${JSON.stringify(started().map((e) => e.data))}`);

  // ---- what an unclaimed spare holds
  const dataMounts = `grep -c -e ' ${k.data}/' -e ' /workspace ' -e ' /clones' /proc/self/mountinfo`;
  for (const id of first) {
    const run = sandboxRunFor(k.run, id);
    const mounts = (await podman(['inspect', '--format', '{{range .Mounts}}{{.Destination}} {{end}}', containerName(id)])).trim().split(' ').sort();
    check(mounts.length === 4 && mounts.includes('/home/agent') && mounts.includes(run) && !mounts.some((m) => m.startsWith(k.data) || m === '/workspace' || m.startsWith('/clones')),
      `spare ${id} was created with its home, its run directory, the model proxy's directory and the releases, and nothing else: ${mounts.join(' ')}`);
    const seen = await inside(id, `${dataMounts}; ls -A /workspace 2>&1 | wc -l; ls ${k.data} 2>&1 | grep -c -v 'No such file'; find ${run}/secrets -type f ! -name env.sh ! -name values.sh | wc -l; cat ${run}/secrets/*/values.sh | grep -c =; true`);
    if (id === first[0]) say(`its home: ${(await inside(id, 'LC_ALL=C ls -A /home/agent; find /home/agent -type f | wc -l')).split('\n').join(' ')}`);
    check(seen === '0\n0\n0\n0\n0', `inside it: no mount from ${k.data}, none at /workspace or /clones, an empty /workspace, no ${k.data}, no secret file and no secret value in its run directory (${JSON.stringify(seen)})`);
    const env = JSON.parse(await podman(['inspect', '--format', '{{json .Config.Env}}', containerName(id)])) as string[];
    const names = env.map((e) => e.split('=')[0]);
    check(!names.some((x) => /TOKEN$|KEY|SECRET|PASSWORD|ANTHROPIC|SLACK|GH_|GITHUB/.test(x.replace('SP_TOKEN_SOCKET', ''))), `its environment holds no credential: ${names.join(' ')}`);
    const env0 = readFileSync(path.join(run, 'boot.env'), 'utf8');
    const spec = JSON.parse(/^RUNNER_SPEC='(.*)'$/m.exec(env0)?.[1] ?? '{}');
    check(Object.keys(spec).sort().join() === 'id,socket,version' && spec.id === id, `its boot.env names no session, no API, no journal: RUNNER_SPEC ${JSON.stringify(spec)}; names ${env0.split('\n').map((l) => l.split('=')[0]).filter(Boolean).join(' ')}`);
    check(!k.records().get(id) && !existsSync(path.join(run, 'api')), 'it has no record');
    const before = k.tokenSessions.length;
    const tok = await inside(id, `node -e 'const s=require("net").createConnection(process.env.SP_TOKEN_SOCKET,()=>s.write(JSON.stringify({sessionKey:"C_OTHER:1.1"})+"\\n"));let b="";s.on("data",d=>b+=d).on("end",()=>console.log(b.trim())).on("error",e=>{console.log("error "+e.message)})'`);
    check(!/"token"/.test(tok) && /serves no thread|error/.test(tok) && k.tokenSessions.length === before, `its token socket gives no token, and the gateway is not asked: ${tok}`);
  }
  await sleep(5000);
  for (const id of first) {
    const c0 = await cgroup(id);
    await sleep(5000);
    const c = await cgroup(id);
    const top = (await podman(['top', containerName(id), 'pid', 'rss', 'args'])).trim().split('\n').slice(1);
    say(`TIMING an idle spare ${id}: ${c.memory} MB in its unit's cgroup (anonymous ${c.anon} MB, file ${c.file} MB), ${c.pids} tasks, ${Math.round((c.cpuUs - c0.cpuUs) / 1000)} ms of CPU in 5 s, ${top.length} processes: ${top.map((l) => l.trim().split(/\s+/).slice(1, 4).join(' ').slice(0, 60)).join(' | ')}`);
  }

  // ---- the claim
  const one = newThread();
  const d1 = await one.deliver();
  const c1 = await evLater(d1.trace, 'runner.claimed');
  check(!!d1.reply?.ok && !!c1 && first.includes(one.id()), `a new thread's first delivery → ok in ${d1.ms} ms, in the container of spare ${one.id()} (${d1.reply?.error ?? ''})`);
  check(c1?.data?.launch_mode === 'podman' && typeof c1.data['container.mount_ms'] === 'number' && typeof c1.data['container.add_ms'] === 'number' && !ev(d1.trace, 'runner.launched'),
    `runner.claimed: ${JSON.stringify(c1?.data)} duration ${c1?.duration_ms} ms, and no runner.launched`);
  const rec = k.records().get(one.id());
  check(rec?.key === one.key && rec.person === PAT.dir && !!rec.repos?.hello, `the record under the spare's id is the thread's: ${JSON.stringify(rec)}`);
  const mounted = (await one.inside("awk '{print $5}' /proc/self/mountinfo | grep -E '^/(workspace|clones)' | sort")).split('\n').join(' ');
  check(mounted === '/clones/hello /clones/hello/.git/worktrees /workspace', `mounted into it at the claim: ${mounted}`);
  const wt = await one.inside('cd /workspace/hello && git status --porcelain --branch && LC_ALL=C ls -A /workspace');
  check(wt.startsWith('## sp/') && /\.fork\.json/.test(wt) && /AGENTS\.md/.test(wt), `its worktree and root files are there: ${JSON.stringify(wt)}`);
  check(!!(await until(async () => (/chat\.postMessage .*cwd/.test(await one.logs()) ? true : undefined))), 'the claimed runner answered !status');
  const st = (await one.logs()).split('\n').find((l) => /chat\.postMessage .*cwd/.test(l)) ?? '';
  check(/\/workspace\b/.test(st) && !st.includes(k.data), 'its cwd is /workspace, and it names no host path');
  const tk = await one.askToken();
  check(tk.startsWith('ghs_fake') && k.tokenSessions.at(-1) === one.key, `its token socket now asks for this thread (${tk}, ${k.tokenSessions.at(-1)})`);
  const other = first.find((id) => id !== one.id()) as string;
  check((await inside(other, `${dataMounts}; true`)) === '0' && !k.records().get(other), `the other spare ${other} still has no mount and no record`);
  const d1b = await one.deliver();
  check(!!d1b.reply?.ok, `a second delivery to the claimed thread → ok in ${d1b.ms} ms`);
  const refilled = await full(POOL);
  check(refilled.length === POOL && refilled.includes(other) && !refilled.includes(one.id()), `the pool is ${POOL} again: ${refilled.join(', ')}`);

  // ---- timings: with a repository, then with none and a warm delivery beside each refill
  const warmRepos = await batch('spare, 1 repository', N, POOL);
  await drop(warmRepos.ts);
  k.welcome('no repositories', false);
  await sleep(1500);
  const quiet: number[] = [];
  const beside: number[] = [];
  const reply: number[] = [];
  const made: SpareThread[] = [];
  let took = 0;
  for (let i = 0; i < N; i++) {
    await full(POOL);
    quiet.push((await one.deliver()).ms);
    const t = newThread();
    made.push(t);
    const d = await t.deliver();
    await until(async () => ((await spares()).length === POOL ? true : undefined), 15_000, 50); // the pool is being topped up now
    beside.push((await one.deliver()).ms);
    if (d.reply?.ok) reply.push(d.ms);
    if (await evLater(d.trace, 'runner.claimed')) took++;
  }
  say(`TIMING spare, no repository: first reply ${row(reply)}`);
  say(`TIMING a delivery to a running thread: ${row(quiet)} with the pool full; ${row(beside)} while a spare is made after a claim`);
  check(took === N, `spare, no repository: ${took} of ${N} took a spare`);
  await drop(made);
  k.welcome('with a repository', true);
  await sleep(1500);
  await full(POOL);
  const burst = [newThread(), newThread(), newThread()];
  const out: string[] = [];
  const ds = [];
  for (const t of burst) ds.push(await t.deliver());
  for (const d of ds) out.push(`${d.ms} ms (${(await evLater(d.trace, 'runner.claimed')) ? 'spare' : 'no spare'}${d.reply?.ok ? '' : ` FAILED ${d.reply?.error}`})`);
  say(`TIMING three new threads back to back, 1 repository, pool of ${POOL}: ${out.join(', ')}`);
  await drop(burst);
  const total = started().length;
  const now = await full(POOL);
  check(now.length === POOL && started().length >= total, `the pool is ${POOL}, never more: ${now.join(', ')} (${started().length} spares made in all)`);

  // ---- a claim that fails: the spares are paused, so the one taken cannot be made the thread's
  for (const id of now) await podman(['pause', containerName(id)]);
  const f = newThread();
  const df = await f.deliver();
  for (const id of now) await podman(['unpause', containerName(id)]).catch(() => {}); // the one taken is gone
  const missed = await evLater(df.trace, 'pool.spare_missed');
  const cold = await evLater(df.trace, 'runner.launched');
  check(!!df.reply?.ok && !!missed && !!cold && !ev(df.trace, 'runner.claimed'),
    `a spare that cannot be claimed: the delivery is answered in ${df.ms} ms by a cold start (pool.spare_missed ${JSON.stringify(missed?.data)}, runner.launched ${JSON.stringify(cold?.data)}) ${df.reply?.error ?? ''}`);
  check(now.includes(f.id()) && (await status(f.id())) === 'running' && (await f.inside(dataMounts)) !== '0', `under the id of the spare that was taken (${f.id()}), in a container made anew, with its workspace mounted`);
  const left = now.find((id) => id !== f.id()) as string;
  check((await status(left)) === 'running' && !k.records().get(left), `the spare that was not taken (${left}) is still a spare`);
  const dfb = await f.deliver();
  check(!!dfb.reply?.ok, `the thread goes on: next delivery ok in ${dfb.ms} ms`);
  await drop([one]);

  // ==== host C: another release and image; B is killed, its spares keep running
  const old = await full(POOL);
  await halt('SIGKILL');
  check(old.length === POOL && (await Promise.all(old.map(status))).every((s) => s === 'running') && (await status(f.id())) === 'running', `host B killed: its spares ${old.join(', ')} and the thread's container still run`);
  await podman(['tag', k.image, NEXT_IMAGE]);
  try {
    // ---- the image lock, held as provisioning holds it while it pulls an image
    const lockable = (() => { try { return accessSync(IMAGE_LOCK, constants.R_OK), true; } catch { return false; } })();
    const lock = lockable ? spawn('/usr/bin/flock', ['--exclusive', IMAGE_LOCK, '/usr/bin/sleep', String(LOCK_S)], { stdio: 'ignore' }) : undefined;
    const released = lock && new Promise((r) => lock.once('exit', r));
    if (lock) await sleep(300);
    // This check's own Podman calls wait for the lock as the host's do, so while it is held only files and frames are read.
    const before = { events: k.events.length };
    const madeByNext = () => started().filter((e) => e.service_version === NEXT_VERSION).length; // host B's last event may still be on its way
    // A host takes its containers back before it says hello (sweep.ts `reconcile`), and that waits for the lock too.
    const up = boot('C', { SP_POOL_SIZE: '1', SP_VERSION: NEXT_VERSION, SP_IMAGE: NEXT_IMAGE, SP_IDLE_MS: String(k.idleMs) });
    up.catch(() => {});
    if (lock) {
      await sleep((LOCK_S - 2) * 1000);
      const seen = { held: lock.exitCode === null, hello: k.events.slice(before.events).some((e) => e.t === 'hello'), there: old.filter((id) => existsSync(sandboxRunFor(k.run, id))).length, made: madeByNext() };
      check(seen.held && !seen.hello && seen.there === old.length && seen.made === 0, `the image lock held for ${LOCK_S - 2} s of host C: it has not said hello, no spare was made and none removed (${JSON.stringify(seen)})`);
      await released;
    } else say(`SKIP the image lock: no ${IMAGE_LOCK} this check may read (as root: install -m 640 -g <the host's group> /dev/null ${IMAGE_LOCK})`);
    await up;
    const goneAt = Date.now();
    const vols = () => Promise.all(old.map((id) => podman(['volume', 'exists', volumeName(id)]).then(() => true, () => false)));
    const gone = await until(async () => ((await Promise.all(old.map(status))).every((s) => s === 'none') && !(await vols()).some(Boolean) && !old.some((id) => existsSync(sandboxRunFor(k.run, id))) ? true : undefined), 60_000);
    check(!!gone, `the new host removed the old release's spares, their homes and run directories (${Date.now() - goneAt} ms)`);
    check((await status(f.id())) === 'running' && !!k.records().get(f.id()), "and left the thread's container, which has a record");
    const next = await full(1, 120_000);
    const env1 = next[0] ? readFileSync(path.join(sandboxRunFor(k.run, next[0]), 'boot.env'), 'utf8') : '';
    check(next.length === 1 && !old.includes(next[0]) && env1.includes(`"version":"${NEXT_VERSION}"`) && (await podman(['inspect', '--format', '{{.Config.Image}}', containerName(next[0])])).trim() === NEXT_IMAGE,
      `SP_POOL_SIZE=1: one spare, from the new release and the new image (${next.join(', ')})`);
    const g = newThread();
    const dg = await g.deliver();
    check(!!dg.reply?.ok && g.id() === next[0] && !!(await evLater(dg.trace, 'runner.claimed')), `a new thread takes it: ok in ${dg.ms} ms`);
    // ---- idle: the thread stops, the spare beside it stays
    const stay = await full(1);
    const idleAt = Date.now();
    check(!!(await until(async () => ((await status(g.id())) === 'exited' ? true : undefined), k.idleMs + 40_000)), `idle for ${k.idleMs} ms: the claimed thread's container exited (${Date.now() - idleAt} ms)`);
    await sleep(3000);
    check(stay.length === 1 && (await status(stay[0])) === 'running' && (await parked(stay[0])) && (await spares()).join() === stay[0], `the spare ${stay[0]} outlived the idle time and is still parked, the only one`);
    // ---- the host stops, and its spare's runner answers nothing
    await podman(['exec', '--user', '0:0', containerName(stay[0]), 'pkill', '-STOP', '-f', '[r]unner-boot']).catch((e) => say(`pkill: ${e.message}`));
    const frozen = (await podman(['top', containerName(stay[0]), 'state', 'args'])).split('\n').filter((l) => /runner-boot/.test(l));
    const stopAt = Date.now();
    await halt('SIGTERM');
    const stopMs = Date.now() - stopAt;
    const left = `container ${await status(stay[0])}, home ${(await podman(['volume', 'exists', volumeName(stay[0])]).then(() => 'there', () => 'gone'))}, run directory ${existsSync(sandboxRunFor(k.run, stay[0])) ? 'there' : 'gone'}`;
    check(frozen.length > 0 && frozen.every((l) => /^T/.test(l.trim())) && host?.signalCode !== 'SIGKILL' && left === 'container none, home gone, run directory gone',
      `host C stopped in ${stopMs} ms while its spare's runner was frozen (${frozen.map((l) => l.trim().slice(0, 40)).join(' | ')}): the spare left by its container (${left})`);
    await boot('D', { SP_POOL_SIZE: '0', SP_VERSION: NEXT_VERSION, SP_IMAGE: NEXT_IMAGE, SP_IDLE_MS: String(k.idleMs) });
    check((await status(stay[0])) === 'none' && !existsSync(sandboxRunFor(k.run, stay[0])), 'the next host finds nothing of it');
    await sleep(3000);
    check((await spares()).length === 0, 'and with SP_POOL_SIZE=0 it makes none');
    await halt('SIGTERM');
  } finally {
    await halt('SIGKILL');
    await drop([f]);
    for (const id of await spares().catch(() => [])) await podman(['rm', '--force', '--volumes', containerName(id)]).catch(() => {});
    await podman(['untag', k.image, NEXT_IMAGE]).catch((e) => say(`cleanup: ${e.message}`));
  }
}
