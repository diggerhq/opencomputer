// The part of sandbox-check.ts about what waits for what on a `podman` host
// (work 103; the gaps closed after step 10): a start, a terminal and `/files`
// while provisioning holds the image lock; a download whose session is
// stopped under it; a prune and a `/files` script on one stopped thread; and
// the home volume of an id whose run directory is gone, as after a reboot.
// sandbox-check.ts owns the host, the fake gateway and the threads;
// sandbox-check-restart.ts ran before and left the host that runs here.
//
// Invariants:
// - It runs on the host the restart checks started last: a sweep age of
//   seconds and a retention of seconds. A thread it wants whole is delivered
//   to; the two it wants pruned are left to go idle.
// - The relay it plays is a new connection: the wire socket of the first host
//   went with it.
// - The image lock is the computer's (image-lock.ts): held only when its file
//   is there and readable, for LOCK_S, which is longer than a person is kept
//   waiting (sandbox/use.ts WAIT_MS) and shorter than a relay's call.
// - The homes it plants have ids of their own, and it removes them, pass or
//   fail: one labelled as this host's with no run directory (must go), one
//   labelled as another host's with a run directory of this one, and one
//   without a label and without a run directory (both must stay).
// - The session of the download is stopped by killing its first process:
//   everything in the container goes with it, as at an idle stop.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IMAGE_LOCK } from '../host/sandbox/image-lock.js';
import { containerName, HOME_LABEL, volumeName } from '../host/sandbox/podman-args.js';
import { WAIT_MS } from '../host/sandbox/use.js';
import { UPDATING } from '../host/unavailable.js';
import { sandboxRunFor } from '../ipc.js';
import type { ApiError } from '../protocol.js';
import type { Rig, T } from './sandbox-check-restart.js';
import { wireClient } from './wire-client.js';

const LOCK_S = 16;
/** The second host's retention (sandbox-check-restart.ts), and a little more. */
const RETENTION_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tarOf(name: string, bytes: number): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandbox-check-'));
  try {
    writeFileSync(path.join(dir, name), randomBytes(bytes));
    return execFileSync('/usr/bin/tar', ['-cf', '-', '-C', dir, name], { maxBuffer: 128 << 20 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `b` and `e` are two running threads of one person, both with nothing unsaved; `e` is pruned here, `b` loses its container at least. */
export async function waits(x: Rig, b: T, e: T) {
  const { check, say, until } = x.kit;
  const podman = (args: string[], timeoutMs = 30_000) => x.as.podman(args, { timeoutMs });
  const has = (kind: 'container' | 'volume', name: string) => podman([kind, 'exists', name]).then(() => true, () => false);
  const status = (t: T) => t.inspect('{{.State.Status}}');
  const dir = (id: string) => sandboxRunFor(x.run, id);
  const [Y, O, N] = Array.from({ length: 3 }, () => randomBytes(8).toString('hex'));
  const member = b.owner.userId as string;
  const err = (r: object) => ('error' in r ? (r.error as ApiError | undefined) : undefined);
  const brief = (r: object) => (err(r) ? `${err(r)?.code}: ${err(r)?.message}` : 'answered');
  let holder: ChildProcess | undefined;
  let keeping: NodeJS.Timeout | undefined;
  const wire = await wireClient(path.join(x.run, 'wire', 'wire.sock'));

  try {
    // ---- planted: homes of no container and no record, for the sweep to judge by their label
    await podman(['volume', 'create', '--label', `${HOME_LABEL}=${dir(Y)}`, volumeName(Y)]);
    await podman(['volume', 'create', '--label', `${HOME_LABEL}=/run/sandbox-check-elsewhere/sandbox/${O}`, volumeName(O)]);
    await podman(['volume', 'create', volumeName(N)]);
    mkdirSync(dir(O));
    const plantedAt = Date.now();

    const [sb, se] = [await x.known(b.spec), await x.known(e.spec)];
    await Promise.all([b.deliver(), e.deliver()]);
    keeping = setInterval(() => void b.deliver(), 8000);
    const list = (s: string) => wire.call<{ entries: { path: string }[] }>({ t: 'files.list', sessionId: s, member, path: '', depth: 1, limit: 200 });
    const before = await list(sb);
    check(!!before.result, `over a new connection to the wire socket, /files of the running thread answers (${brief(before)})`);

    // ---- the image lock held: a resume waits for it; a terminal and /files wait their own limit and say so
    check(!!(await until(async () => ((await status(e)) === 'exited' ? true : undefined), 60_000)), 'the thread that is not delivered to went idle and is stopped');
    const eid = e.id();
    const canLock = existsSync(IMAGE_LOCK) && (() => { try { return accessSync(IMAGE_LOCK, constants.R_OK), true; } catch { return false; } })();
    if (canLock) {
      holder = spawn('/usr/bin/flock', ['--exclusive', IMAGE_LOCK, '/usr/bin/sleep', String(LOCK_S)], { stdio: 'ignore' });
      await sleep(300);
      const timed = async <R>(p: Promise<R>) => {
        const at = Date.now();
        const r = await p;
        return { r, ms: Date.now() - at };
      };
      const [start, term, files] = await Promise.all([timed(e.deliver()), timed(wire.terminal(sb, member, 'id -u')), timed(list(sb))]);
      const within = (ms: number) => ms >= WAIT_MS - 1500 && ms <= WAIT_MS + 4000;
      check(!!start.r.reply?.ok && start.ms >= LOCK_S * 1000 - 2500 && e.id() === eid && (await status(e)) === 'running',
        `while provisioning holds the image lock (${LOCK_S} s) the start of a stopped thread waits for it: answered in ${start.ms} ms, in the same container (${start.r.reply?.error ?? ''})`);
      check(err(term.r)?.code === 'unavailable' && err(term.r)?.message === UPDATING && err(term.r)?.retryable === true && within(term.ms),
        `a terminal opened meanwhile is refused after ${term.ms} ms: ${brief(term.r)}`);
      check(err(files.r)?.code === 'unavailable' && err(files.r)?.message === UPDATING && within(files.ms), `and so is /files, after ${files.ms} ms: ${brief(files.r)}`);
      const [term2, files2] = [await wire.terminal(sb, member, 'id -u'), await list(sb)];
      check('out' in term2 && term2.out.trim() === '1500' && !!files2.result, `once the lock is released both answer again (${brief(term2)}, ${brief(files2)})`);
    } else {
      say(`SKIP a start, a terminal and /files under the image lock: no readable ${IMAGE_LOCK} here (root: install -m 0640 -g <the host's group> /dev/null ${IMAGE_LOCK})`);
      const r = await e.deliver();
      check(!!r.reply?.ok && e.id() === eid, `the stopped thread resumes in ${r.ms} ms`);
    }

    // ---- a session stopped under a download: the download says so, and the next read is answered from the stopped thread
    const big = await wire.put(se, member, 's11-big', tarOf('big.bin', 48 << 20));
    const dl = await wire.getPaused(se, member, 's11-big/big.bin', true);
    if ('error' in dl) check(false, `a download from the running thread starts (upload: ${brief(big)}; download: ${brief(dl)})`);
    else {
      await sleep(500);
      // Its first process is killed: as at the idle stop, everything in the container goes with it.
      // Its first process is killed, as when a runner leaves. While nobody reads the download the container does not reach
      // `exited`, and `podman kill` gives up waiting for it (measured, Podman 4.9.3): so the reader reads on first.
      const killAt = Date.now();
      const killing = podman(['kill', '--signal', 'KILL', containerName(eid)]).then(() => 'killed', (err_) => `podman kill: ${String(err_.message).split('\n').pop()}`);
      await sleep(1500);
      const end = await dl.rest();
      const gone = await until(async () => ((await status(e)) === 'exited' ? true : undefined), 60_000);
      say(`the container of the download: ${await killing}; ${gone ? 'exited' : 'not exited'} ${Date.now() - killAt} ms after`);
      check(end.error?.code === 'unavailable' && /The session stopped during the download/.test(end.error.message) && end.got < 48 << 20,
        `a download whose session is stopped under it ends after ${end.got} bytes with ${end.error?.code}: ${end.error?.message}`);
      const after = await list(se);
      check(!!after.result?.entries.some((f) => f.path === 's11-big'), `and a listing right after is answered from the stopped thread (${brief(after)})`);
    }

    // ---- a prune and a /files script on one stopped thread
    check(!!(await until(async () => ((await status(e)) === 'exited' ? true : undefined), 30_000)) && !!e.record()?.repos?.hello, 'the thread is stopped, with its record');
    const small = tarOf('a.txt', 2048);
    const held = await wire.putHeld(se, member, 's11-held', small, small.length >> 1);
    check('finish' in held, `an upload to the stopped thread is under way, half sent (${brief(held)})`);
    clearInterval(keeping);
    await b.deliver();
    const idleAt = Date.now();
    check(!!(await until(async () => ((await status(b)) === 'exited' ? true : undefined), 60_000)), 'the other thread went idle too');
    await sleep(Math.max(0, RETENTION_MS - (Date.now() - idleAt)));
    const bName = containerName(b.id());
    // A changed definition starts a housekeeping pass, unless one is running: asked again until it shows.
    for (let n = 0; n < 15 && (await has('container', bName)); n++) {
      x.welcome(`waits ${n}`);
      await until(async () => ((await has('container', bName)) ? undefined : true), 10_000);
    }
    x.welcome('waits again');
    await sleep(10_000);
    const whole = !!e.record()?.repos?.hello && e.id() === eid && (await has('container', containerName(eid))) && (await has('volume', volumeName(eid))) && existsSync(e.workspace);
    check(!(await has('container', bName)) && whole,
      `housekeeping passed over both, idle beyond retention: the other thread's container is gone, and the one with an upload in it is whole (record, container, home, workspace)`);
    const done = 'finish' in held ? await held.finish() : held;
    const back = await wire.get(se, member, 's11-held/a.txt', true);
    check(done && 'result' in done && done.result?.upload.files === 1 && 'body' in back && back.body.length === 2048, `the upload then ends well (${brief(done)}) and what it brought reads back (${brief(back)})`);
    // The moment the removal shows (the record without repositories, or gone), /files is asked once more.
    let seen = '';
    const raced = (async () => {
      for (const end = Date.now() + 200_000; Date.now() < end; await sleep(5)) {
        const r = e.record();
        if (r?.repos?.hello && r.id === eid) continue;
        seen = r ? 'its record had lost its repositories' : 'its record was gone';
        return list(se);
      }
    })();
    for (let n = 0; n < 15 && !seen; n++) {
      x.welcome(`waits more ${n}`);
      await until(() => (seen ? true : undefined), 10_000);
    }
    const refused = await raced;
    check(!!refused && err(refused)?.code === 'unavailable' && /being cleaned up/.test(err(refused)?.message ?? ''),
      `with no upload in it the thread is pruned at a later pass, and /files asked while it is removed (${seen || 'the prune never showed'}) is refused: ${refused ? brief(refused) : 'never asked'}`);
    check(!!(await until(async () => (!e.record() && !(await has('container', containerName(eid))) && !(await has('volume', volumeName(eid))) && !existsSync(e.workspace) ? true : undefined), 30_000)),
      'and it is gone whole: record, container, home, workspace');

    // ---- the homes planted at the start
    await sleep(Math.max(0, 20_000 - (Date.now() - plantedAt)));
    check(!!(await until(async () => ((await has('volume', volumeName(Y))) ? undefined : true), 30_000)), `the home labelled as this host's, of an id with no run directory (as after a reboot), was removed by the sweep`);
    check((await has('volume', volumeName(O))) && (await has('volume', volumeName(N))),
      `the home labelled as another host's stays, though this host has a run directory for its id; and so does the one without a label and without a run directory`);
  } finally {
    clearInterval(keeping);
    holder?.kill();
    wire.close();
    for (const id of [Y, O, N]) await podman(['volume', 'rm', '--force', volumeName(id)]).catch(() => {});
    rmSync(dir(O), { recursive: true, force: true });
  }
}
