import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { imageBusy, imageSettled } from './image-lock.js';
import { asRunner, type Exec, PodmanError } from './podman.js';

describe('imageSettled', () => {
  it('costs nothing where provisioning never took the lock', async () => {
    const flock = vi.fn(async () => 0);
    expect(await imageSettled({ exists: () => false, flock })).toBe(true);
    expect(flock).not.toHaveBeenCalled();
  });

  it('takes a shared lock with a bound, and goes on when the bound passes or flock cannot run', async () => {
    const flock = vi.fn(async (_: string[]) => 1 as number | undefined);
    // Still held after the bound: it says so, and who called decides (podman.ts).
    await expect(imageSettled({ lock: '/run/x.lock', waitS: 7, exists: () => true, flock })).resolves.toBe(false);
    expect(flock.mock.calls[0][0]).toEqual(['--shared', '--timeout', '7', '/run/x.lock', '/usr/bin/true']);
    await expect(imageSettled({ exists: () => true, flock: async () => undefined })).resolves.toBe(true);
  });

  it('after a wait that was a real one, waits for a run queued behind it too; within the one bound', async () => {
    let t = 0;
    const waits = [40_000, 30_000, 5];
    const flock = vi.fn(async (_: string[]) => ((t += waits.shift() ?? 0), 0));
    await imageSettled({ waitS: 100, exists: () => true, flock, now: () => t, nextMs: 1 });
    expect(flock.mock.calls.map((c) => c[0][2])).toEqual(['100', '60', '30']);
    // The file left behind by a run that died: one flock, no second look.
    const left = vi.fn(async () => 0);
    await imageSettled({ exists: () => true, flock: left, now: () => 0, nextMs: 1 });
    expect(left).toHaveBeenCalledTimes(1);
    // The bound is for all of it.
    t = 0;
    const long = vi.fn(async (_: string[]) => ((t += 60_000), 0));
    await imageSettled({ waitS: 100, exists: () => true, flock: long, now: () => t, nextMs: 1 });
    expect(long).toHaveBeenCalledTimes(2);
  });

  it('busy: only while the file is there and held', async () => {
    expect(await imageBusy({ exists: () => false })).toBe(false);
    expect(await imageBusy({ exists: () => true, flock: async () => 0 })).toBe(false);
    expect(await imageBusy({ exists: () => true, flock: async () => undefined })).toBe(false);
    const flock = vi.fn(async (_: string[]) => 1);
    expect(await imageBusy({ lock: '/run/x.lock', exists: () => true, flock })).toBe(true);
    expect(flock.mock.calls[0][0]).toEqual(['--shared', '--nonblock', '/run/x.lock', '/usr/bin/true']);
  });

  it.runIf(existsSync('/usr/bin/flock'))('waits for as long as the lock is held', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'image-lock-'));
    const lock = path.join(dir, 'lock');
    writeFileSync(lock, '');
    // Free: at once.
    let t0 = Date.now();
    await imageSettled({ lock });
    expect(Date.now() - t0).toBeLessThan(400);
    const holder = spawn('/usr/bin/flock', ['--exclusive', lock, '/usr/bin/sleep', '0.6'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    t0 = Date.now();
    await imageSettled({ lock });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    // A holder that died holds nothing.
    const dead = spawn('/usr/bin/flock', ['--exclusive', lock, '/usr/bin/sleep', '30'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    await new Promise<void>((r) => execFile('/usr/bin/pkill', ['-KILL', '-P', String(dead.pid)], () => (dead.kill('SIGKILL'), r())));
    t0 = Date.now();
    await imageSettled({ lock });
    expect(Date.now() - t0).toBeLessThan(1000);
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('asRunner with the image lock', () => {
  it('settled: with no bound it waits as podman() does and goes on; with one it refuses when the lock is still held then', async () => {
    const asked: (number | undefined)[] = [];
    const exec = (() => ({})) as unknown as Exec;
    const held = asRunner(['/usr/bin/sudo'], exec, async (d) => (asked.push(d?.waitS), false));
    await expect(held.settled()).resolves.toBeUndefined();
    const e = await held.settled(10_000).catch((x) => x);
    expect([e.name, e.message, e.retryable]).toEqual(['Unavailable', 'The computer is updating, try again in a few minutes.', true]);
    expect(asked).toEqual([undefined, 10]);
    await expect(asRunner(['/usr/bin/sudo'], exec, async () => true).settled(10_000)).resolves.toBeUndefined();
  });

  it('starts no Podman call before provisioning is done, and other commands at once', async () => {
    const started: string[] = [];
    const exec = ((_cmd: string, args: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      started.push(args.includes('/usr/bin/podman') ? 'podman' : 'other');
      queueMicrotask(() => cb(null, '', ''));
      return {};
    }) as unknown as Exec;
    let free!: () => void;
    const settled = new Promise<void>((r) => (free = r));
    const as = asRunner(['/usr/bin/sudo'], exec, () => settled);
    const call = as.podman(['ps'], { timeoutMs: 1000 });
    await as.run(['/usr/bin/systemctl', '--user', 'is-active', 'x'], { timeoutMs: 1000 });
    expect(started).toEqual(['other']);
    free();
    await call;
    expect(started).toEqual(['other', 'podman']);
  });

  it('a Podman call that ran out of time while provisioning holds the lock is made once more, after the wait, only when its caller called it repeatable', async () => {
    const rig = (busy: boolean, fail: (n: number) => Error | null) => {
      const log: string[] = [];
      let n = 0;
      const exec = ((_cmd: string, _args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
        log.push('podman');
        const e = fail(n++);
        if (e) queueMicrotask(() => cb(e, '', ''));
        else queueMicrotask(() => cb(null, 'ok', ''));
        return { kill: () => {} };
      }) as unknown as Exec;
      return { log, as: asRunner(['/usr/bin/sudo'], exec, async () => void log.push('settled'), async () => (log.push('busy?'), busy)) };
    };
    const failed = rig(true, () => Object.assign(new Error('exit 125'), { code: 125 }));
    await expect(failed.as.podman(['ps'], { timeoutMs: 1000, repeatable: true })).rejects.toThrow(PodmanError);
    expect(failed.log).toEqual(['settled', 'podman']);
    // Timing out is the host's own timer: 20 ms, and a command that ends only when it is killed.
    const slow = (busy: boolean) => {
      const log: string[] = [];
      let n = 0;
      const exec = ((_cmd: string, _args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
        log.push('podman');
        if (n++) queueMicrotask(() => cb(null, 'ok', ''));
        return { kill: () => cb(new Error('killed'), '', '') };
      }) as unknown as Exec;
      return { log, as: asRunner(['/usr/bin/sudo'], exec, async () => void log.push('settled'), async () => (log.push('busy?'), busy)) };
    };
    const held = slow(true);
    expect(await held.as.podman(['ps'], { timeoutMs: 20, repeatable: true })).toBe('ok');
    expect(held.log).toEqual(['settled', 'podman', 'busy?', 'settled', 'podman']);
    const free = slow(false);
    await expect(free.as.podman(['ps'], { timeoutMs: 20, repeatable: true })).rejects.toMatchObject({ timedOut: true });
    expect(free.log).toEqual(['settled', 'podman', 'busy?']);
    // Whatever the verb: a call nobody called repeatable (a script's exec, a create, a mount) timed out, lock or no lock, and ran once.
    for (const args of [['exec', 'sp-runner-x', '/bin/sh', 'ws-add.sh'], ['create', '--name', 'x'], ['unshare', 'rm', '-rf', '--', '/x'], ['ps']]) {
      const once = slow(true);
      await expect(once.as.podman(args, { timeoutMs: 20 })).rejects.toMatchObject({ timedOut: true });
      expect(once.log).toEqual(['settled', 'podman']);
    }
  });
});
