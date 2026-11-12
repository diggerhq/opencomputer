// The part of sandbox-check.ts about a host that starts again and about what
// it removes (work 103, step 8): previews after a resume, `unpreview` of
// another session's name, a killed host taking its running containers back,
// a runner socket that was replaced, a container without a record and a
// record without a container, the sweep, the image lock held across a
// restart, and Prune. sandbox-check.ts owns the hosts, the fake gateway and
// the threads; this file plants, restarts, and compares.
//
// Invariants:
// - It kills the host with SIGKILL, never asks it to stop: what is checked is
//   what a host that died leaves and what the next one makes of it.
// - Everything it plants has an id of its own, and it removes all of it, pass
//   or fail. One container and one volume are planted as another host's (no
//   run directory of this one): they must be there at the end, and are then
//   removed here.
// - The image lock is the computer's (image-lock.ts), so it is held only when
//   its file is already there and readable, and for LOCK_S: every host on the
//   computer waits that long for Podman.
// - The second restart runs the host with a sweep age of seconds and a
//   retention of seconds; the threads that must survive are delivered to
//   throughout, and the two that are to be pruned are left to go idle.

import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { IMAGE_LOCK } from '../host/sandbox/image-lock.js';
import type { AsRunner } from '../host/sandbox/podman.js';
import { containerName, unitName, volumeName } from '../host/sandbox/podman-args.js';
import type { SandboxRecord } from '../host/sandbox/records.js';
import { type RunRoot, sandboxRunFor, socketFor } from '../ipc.js';
import type { HostToGateway, Person, SessionSpec } from '../protocol.js';
import type { TelemetryEvent } from '../telemetry/envelope.js';
import { safeKey } from '../workspaces/clones.js';
import { APP_PORT, type Kit, MODEL_URL, type Thread as Reached, model, said, serve, show, toolCall, viaProxy } from './sandbox-check-reach.js';

const LOCK_S = 8;
const SWEEP_AGE_MS = 6000;
/** SP_FORK_RETENTION_DAYS for the second restart: 26 s. */
const RETENTION_DAYS = 0.0003;

/** A thread as sandbox-check.ts makes one. */
export interface T {
  key: string;
  owner: Person;
  spec: SessionSpec;
  record(): SandboxRecord | undefined;
  id(): string;
  readonly run: RunRoot;
  workspace: string;
  registry(repo: string): string;
  branch: string;
  deliver(): Promise<{ reply?: { ok: boolean; error?: string }; ms: number }>;
  inspect(format: string): Promise<string>;
  inside(script: string, as_?: string): Promise<string>;
  pid(): Promise<number>;
  askToken(): Promise<string>;
}

export interface Rig {
  kit: Kit;
  as: AsRunner;
  run: string;
  data: string;
  image: string;
  /** Everything the hosts wrote, by line. */
  lines: string[];
  /** SIGKILL the host; resolves once it is gone. */
  kill(): Promise<void>;
  /** Start one, with these variables on top of the check's; how long until its hello, undefined when none came. */
  start(env?: Record<string, string>): Promise<number | undefined>;
  events: HostToGateway[];
  tel: TelemetryEvent[];
  /** The public names the gateway holds, and the `unpreview`s it got. */
  names: Map<string, number>;
  unpreviewed: { from: string; name: string }[];
  welcome(about: string): void;
  /** A person's clone of a repository, on the host. */
  clone(person: string, repo: string): string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `a` runs, `b` (the same person's) and `q` (another's) are stopped, `c` is a thread nobody started yet. `b` has the
 * preview `s9-b` of APP_PORT and `a` has `s9-none` of APP_PORT + 1, from sandbox-check-reach.ts. Returns the timings.
 */
export async function restarts(x: Rig, A: T, B: T, Q: T, C: T) {
  const { kit: k } = x;
  const { check, say, until } = k;
  const podman = (args: string[], timeoutMs = 30_000) => x.as.podman(args, { timeoutMs });
  const has = (kind: 'container' | 'volume', name: string) => podman([kind, 'exists', name]).then(() => true, () => false);
  const reach = (name: string, t: T): Reached => ({ name, spec: t.spec, sessionId: '', id: t.id(), run: t.run, workspace: t.workspace, member: '' });
  const started = async (t: T) => ({ pid: await t.pid(), at: await t.inspect('{{.State.StartedAt}}') });
  const same = async (t: T, was: { pid: number; at: string }) => (await t.pid()) === was.pid && (await t.inspect('{{.State.StartedAt}}')) === was.at;
  const status = (t: T) => t.inspect('{{.State.Status}}');
  const tookBack = (t: T, from: number) => /taken back for \S+ in (\d+) ms/.exec(x.lines.slice(from).find((l) => l.includes(`taken back for ${t.key} `)) ?? '')?.[1];
  const failedUnit = (id: string) => x.as.run(['/usr/bin/systemctl', '--user', 'is-failed', '--quiet', unitName(id)], { timeoutMs: 5000 }).then(() => true, () => false);
  const port = (name: string) => k.asked.find((q) => q.req.name === name)?.req.port ?? 0;
  const table = () => (JSON.parse(readFileSync(path.join(x.data, 'state', 'previews.json'), 'utf8')) as { entries: { id: string; name?: string }[] }).entries;
  /** Threads delivered to every 8 s: none of them leaves for idleness, and none is idle beyond retention. */
  const kept = new Set<T>();
  const keeping = setInterval(() => void Promise.all([...kept].map((t) => t.deliver())), 8000);
  /** One more delivery to each, and none after: a runner counts its idle time from here, across the restart. */
  const quiesce = async () => {
    const last = [...kept];
    kept.clear();
    await Promise.all(last.map((t) => t.deliver()));
  };
  const [X, F, V, W, D, U] = Array.from({ length: 6 }, () => randomBytes(8).toString('hex'));
  const dir = (id: string) => sandboxRunFor(x.run, id);
  const planted = path.join(x.run, 'runners', 'planted.sock');
  let holder: ChildProcess | undefined;
  const times: Record<string, number | undefined> = {};

  try {
    // ---- previews after a stop and a resume: the runner is told its ports again
    const asked = k.asked.length;
    const [dB, dC] = await Promise.all([B.deliver(), C.deliver()]);
    times.resume_ms = dB.ms;
    check(!!dB.reply?.ok && !!dC.reply?.ok, `the stopped thread resumes in ${dB.ms} ms, and a new one starts in ${dC.ms} ms (${dB.reply?.error ?? ''}${dC.reply?.error ?? ''})`);
    const [a, b, c] = [reach('A', A), reach('B', B), reach('C', C)];
    kept.add(A).add(B).add(C);
    await serve(k, b, APP_PORT);
    await serve(k, a, APP_PORT + 1);
    const gb = await until(async () => (said(await viaProxy(k, port('s9-b')), 'inside B') ? true : undefined), 15_000);
    await until(async () => (said(await viaProxy(k, port('s9-none')), 'inside A') ? true : undefined), 15_000);
    const ga = await viaProxy(k, port('s9-none'));
    check(!!gb && said(ga, 'inside A') && k.asked.length === asked,
      `after a stop and a resume the previews answer again, B's ${port('s9-b')} and A's ${port('s9-none')} (${show(ga)}), and no runner asked for a preview again`);

    // ---- unpreview: only a session's own names
    for (const t of [a, b, c]) await model(k, t);
    await until(async () => ((await Promise.all([a, b, c].map((t) => k.inside(t.id, `curl -s -m 2 ${MODEL_URL}/calls`).catch(() => '')))).every(Boolean) ? true : undefined), 15_000);
    const un = await toolCall(k, a, 'unpreview', { name: 's9-b' });
    check(/no preview named s9-b in this session/.test(un.text) && x.names.has('s9-b') && !x.unpreviewed.some((u) => u.name === 's9-b') && said(await viaProxy(k, port('s9-b')), 'inside B'),
      `A's unpreview of B's name is refused (${un.text}), the gateway was not asked, and B's preview still answers`);
    await serve(k, c, APP_PORT);
    const pc = await toolCall(k, c, 'preview', { port: APP_PORT, name: 's8-c' });
    check(pc.json?.listening === true && x.names.has('s8-c'), `C previews its ${APP_PORT} as s8-c (${pc.text})`);
    await C.inside('echo layer > /opt/s8-layer', '0:0');

    // ---- a killed host: two threads run, one is stopped, one runner's socket was replaced, one socket is planted where hosts used to scan
    await quiesce();
    const fake = `const net=require("net"),fs=require("fs"),p=process.argv[1];fs.renameSync(p,p+".real");net.createServer(s=>{s.on("error",()=>{});s.write(JSON.stringify({t:"report",report:{key:${JSON.stringify(A.key)},status:"idle",forkPath:"/workspace"}})+"\\n")}).listen(p,()=>fs.chmodSync(p,432))`;
    await k.detached(c.id, ['node', '-e', fake, socketFor(c.run, c.id)]);
    const old = `const net=require("net"),fs=require("fs"),p=process.argv[1];net.createServer(s=>{fs.writeFileSync(p+".dialed","1");s.on("error",()=>{});s.write(JSON.stringify({t:"report",report:{key:"C_PLANTED:1.1",status:"idle"}})+"\\n")}).listen(p,()=>fs.chmodSync(p,432))`;
    void x.as.run([process.execPath, '-e', old, planted], { timeoutMs: 900_000 }).catch(() => {});
    check(!!(await until(() => (existsSync(`${socketFor(c.run, c.id)}.real`) && existsSync(socketFor(c.run, c.id)) && existsSync(planted) ? true : undefined), 10_000)),
      `planted: C's session put its own listener at its runner's socket, reporting A's thread; and a listener at ${planted}`);
    const was = { A: await started(A), B: await started(B) };
    let mark = x.lines.length;
    await x.kill();
    times.restart_hello_ms = await x.start();
    check(times.restart_hello_ms !== undefined, `the host was killed with two threads running; the next one said hello after ${times.restart_hello_ms} ms`);
    times.adopt_a_ms = Number(await until(() => tookBack(A, mark), 5000));
    times.adopt_b_ms = Number(await until(() => tookBack(B, mark), 5000));
    check((await same(A, was.A)) && (await same(B, was.B)) && times.adopt_a_ms >= 0 && times.adopt_b_ms >= 0,
      `it took both back (${times.adopt_a_ms} and ${times.adopt_b_ms} ms from the inventory) and neither container was restarted: same process, same start time`);
    const hello = x.events.filter((e): e is Extract<HostToGateway, { t: 'hello' }> => e.t === 'hello').at(-1);
    check(hello?.sessions.map((s) => s.key).sort().join() === [A.key, B.key].sort().join(), `its hello names those two sessions and no other: ${hello?.sessions.map((s) => s.key).join()}`);
    const [rA, rB] = await Promise.all([A.deliver(), B.deliver()]);
    check(!!rA.reply?.ok && !!rB.reply?.ok && (await same(A, was.A)) && (await same(B, was.B)), `a delivery reaches each (${rA.ms} and ${rB.ms} ms), in the same containers`);
    kept.add(A).add(B);
    check((await A.askToken()).startsWith('ghs_fake') && said(await viaProxy(k, port('s9-b')), 'inside B') && k.asked.length === asked + 1,
      "A's token socket answers under the new host, and B's preview answers with no new preview");
    check(!!(await until(async () => ((await status(C)) === 'exited' ? true : undefined), 30_000)) && x.lines.slice(mark).some((l) => l.includes(`it reports ${A.key}, not its record's ${C.key}`)),
      "the container whose socket reported A's thread was not taken back: it is stopped, and its record stays");
    check(existsSync(planted) && !existsSync(`${planted}.dialed`), `the listener planted in ${path.dirname(planted)} was never dialed`);
    const qid = Q.id();
    const [rQ, rC] = await Promise.all([Q.deliver(), C.deliver()]);
    check(!!rQ.reply?.ok && Q.record()?.id === qid && (await status(Q)) === 'running', `the thread that was stopped across the restart resumes in ${rQ.ms} ms (${rQ.reply?.error ?? ''})`);
    check(!!rC.reply?.ok && (await C.inside('cat /opt/s8-layer')) === 'layer', `and the stopped one answers again as its own thread in ${rC.ms} ms, with what root wrote outside its home before the stop (${rC.reply?.error ?? ''})`);
    kept.add(Q);

    // ---- planted for the second restart; A and C are left to go idle
    kept.delete(A);
    for (const id of [X, V, D]) mkdirSync(dir(id));
    const make = (id: string, binds: string[]) =>
      podman(['create', '--name', containerName(id), '--label', `sp.runner=${id}`, '--userns=keep-id:uid=1500,gid=1500', '-v', `${volumeName(id)}:/home/agent`, ...binds, x.image, 'true'], 60_000);
    await make(X, ['-v', `${dir(X)}:${dir(X)}`]); // this host's, by its run directory, and of no record
    await make(F, []); // another host's
    for (const id of [V, W]) await podman(['volume', 'create', volumeName(id)]);
    for (const id of [V, U]) await x.as.run(['/usr/bin/systemd-run', '--user', '--quiet', '--unit', unitName(id), '/bin/false'], { timeoutMs: 10_000 }).catch(() => {});
    check(!!(await until(async () => ((await failedUnit(V)) && (await failedUnit(U)) ? true : undefined), 10_000)), 'planted: a container and a home of no record, a home and a failed unit with a run directory, an empty run directory; and a container, a home and a failed unit of no run directory of this host');
    await Q.inside('echo kept > /home/agent/s8-marker');
    await quiesce();
    const wasB = await started(B);
    const canLock = existsSync(IMAGE_LOCK) && (() => { try { return accessSync(IMAGE_LOCK, constants.R_OK), true; } catch { return false; } })();
    mark = x.lines.length;
    const telMark = x.tel.length;
    await x.kill();
    await podman(['rm', '--force', containerName(qid)]); // a record with no container
    if (canLock) {
      holder = spawn('/usr/bin/flock', ['--exclusive', IMAGE_LOCK, '/usr/bin/sleep', String(LOCK_S)], { stdio: 'ignore' });
      await sleep(300);
    }
    times.restart_locked_hello_ms = await x.start({ SP_SWEEP_AGE_MS: String(SWEEP_AGE_MS), SP_FORK_RETENTION_DAYS: String(RETENTION_DAYS) });
    const [rB2, rQ2] = await Promise.all([B.deliver(), Q.deliver()]);
    kept.add(B).add(Q);
    const back = !!rB2.reply?.ok && (await same(B, wasB)) && tookBack(B, mark) !== undefined;
    if (canLock) check((times.restart_locked_hello_ms ?? 0) >= LOCK_S * 1000 - 1500 && back,
      `a host that starts while provisioning holds the image lock (${LOCK_S} s) waits for it (hello after ${times.restart_locked_hello_ms} ms), then takes B back without restarting it`);
    else {
      say(`SKIP the image lock held across a restart: no readable ${IMAGE_LOCK} here (root: install -m 0640 -g <the host's group> /dev/null ${IMAGE_LOCK})`);
      check(back, `the second host said hello after ${times.restart_locked_hello_ms} ms and took B back without restarting it`);
    }

    // ---- what the start removes, and what a record without a container gets
    check(!!(await until(async () => (!(await has('container', containerName(X))) && !(await has('volume', volumeName(X))) ? true : undefined), 20_000)), 'the container with no record, and its home, are removed at the start');
    check(!!rQ2.reply?.ok && Q.record()?.id === qid && (await Q.inside('cat /home/agent/s8-marker')) === 'kept', `the record whose container was removed gets a new container in ${rQ2.ms} ms, under the same id and with its home (${rQ2.reply?.error ?? ''})`);

    // ---- the sweep
    const sweptAt = Date.now();
    check(!!(await until(async () => (!(await has('volume', volumeName(V))) && ![V, X, D].some((id) => existsSync(dir(id))) && !(await failedUnit(V)) ? true : undefined), 60_000)),
      `the sweep removed the home of no record, the three run directories of no container, and reset the failed unit (${Date.now() - sweptAt} ms after the start's checks; objects older than ${SWEEP_AGE_MS} ms)`);
    check((await has('container', containerName(F))) && (await has('volume', volumeName(F))) && (await has('volume', volumeName(W))) && (await failedUnit(U)),
      'the container, the homes and the failed unit that have no run directory of this host are untouched');
    const swept = await until(() => x.tel.slice(telMark).find((e) => e.event_name === 'sandbox.swept'), 15_000);
    check(!!swept, `sandbox.swept: ${JSON.stringify(swept?.data)}`);
    const whole = async (t: T) => (await status(t)) === 'running' && (await has('volume', volumeName(t.id()))) && existsSync(t.run) && !!t.record();
    check((await whole(B)) && (await whole(Q)) && (await same(B, wasB)), "the running threads, one of each person, have their containers, homes, run directories and records; B's container never restarted");

    // ---- Prune: C is clean and pushed (nothing was committed), A has a commit on no remote
    const [aid, cid, crun] = [A.id(), C.id(), C.run];
    check(!!(await until(async () => ((await status(A)) === 'exited' && (await status(C)) === 'exited' ? true : undefined), 90_000)), 'A and C went idle and are stopped');
    const pruneAt = Date.now();
    // A changed definition starts a housekeeping pass, unless one is running: asked again until it shows.
    for (let n = 0; n < 15 && C.record(); n++) {
      x.welcome(`fourth ${n}`);
      await until(() => (C.record() ? undefined : true), 10_000);
    }
    check(!C.record() && !(await has('container', containerName(cid))) && !(await has('volume', volumeName(cid))) && !existsSync(C.workspace) && !existsSync(path.dirname(C.registry('x'))) && !existsSync(crun),
      `a thread idle beyond retention with nothing unsaved is pruned (${Date.now() - pruneAt} ms after it was seen stopped; retention ${Math.round(RETENTION_DAYS * 86_400)} s): container, home, workspace, registries, run directory, record`);
    const branch = await x.as.run(['/usr/bin/git', '-C', x.clone(C.owner.dir, 'hello'), 'branch', '--list', C.branch], { timeoutMs: 10_000 }).catch((e) => `error: ${e.message}`);
    check(branch.trim() === '', `its branch is forgotten in the person's clone (${JSON.stringify(branch.trim())})`);
    check(!!(await until(() => (!x.names.has('s8-c') && x.unpreviewed.some((u) => u.name === 's8-c' && u.from === C.key) ? true : undefined), 10_000)) && !table().some((e) => e.id === cid),
      `the gateway was told to unpreview s8-c for ${C.key}, and the table holds no port of the removed sandbox`);
    const row = await until(() => x.events.flatMap((e) => (e.t === 'workspace' ? e.status.repos : [])).find((r) => r.name === `sessions/${safeKey(A.key)}`), 30_000);
    check(!!A.record() && !(await has('container', containerName(aid))) && (await has('volume', volumeName(aid))) && existsSync(A.workspace) && /kept: /.test(row?.problem ?? ''),
      `the thread with unsaved work loses only its container; housekeeping reports: ${row?.problem}`);
    check(x.names.has('s9-none') && table().some((e) => e.id === aid && e.name === 's9-none'), 'and its preview stays');
    const rA3 = await A.deliver();
    const inA = await A.inside('cat /home/agent/sandbox-check-marker; git -C /workspace/hello log --format=%s -1');
    check(!!rA3.reply?.ok && A.record()?.id === aid && inA === 'kept\nfrom the terminal', `its next message creates the container again in ${rA3.ms} ms, with its home and its commit (${JSON.stringify(inA)} ${rA3.reply?.error ?? ''})`);
    check((await whole(B)) && (await whole(Q)), 'the threads in use were not pruned');

    // ---- health
    const sample = await until(() => x.tel.slice(telMark).find((e) => e.event_name === 'host.sample' && typeof e.data?.containers_running === 'number'), 70_000);
    check(typeof sample?.data?.data_used_pct === 'number' && typeof sample.data.podman_bytes === 'number', `host.sample carries the containers by state and the disk: ${JSON.stringify(sample?.data)}`);
  } finally {
    clearInterval(keeping);
    holder?.kill();
    const quiet = (p: Promise<unknown>) => p.catch(() => {});
    await quiet(x.as.run(['/usr/bin/pkill', '-f', planted], { timeoutMs: 5000 }));
    for (const f of [planted, `${planted}.dialed`]) rmSync(f, { force: true });
    for (const id of [X, F]) await quiet(podman(['rm', '--force', containerName(id)]));
    for (const id of [X, F, V, W]) await quiet(podman(['volume', 'rm', '--force', volumeName(id)]));
    for (const id of [X, V, D]) rmSync(dir(id), { recursive: true, force: true });
    await quiet(x.as.run(['/usr/bin/systemctl', '--user', 'reset-failed', unitName(V), unitName(U)], { timeoutMs: 5000 }));
  }
  return times;
}
