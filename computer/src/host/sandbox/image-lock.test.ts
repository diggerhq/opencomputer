import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { imageSettled } from './image-lock.js';
import { asRunner, type Exec } from './podman.js';

describe('imageSettled', () => {
  it('costs nothing where provisioning never took the lock', async () => {
    const flock = vi.fn(async () => 0);
    await imageSettled({ exists: () => false, flock });
    expect(flock).not.toHaveBeenCalled();
  });

  it('takes a shared lock with a bound, and goes on when the bound passes or flock cannot run', async () => {
    const flock = vi.fn(async (_: string[]) => 1 as number | undefined);
    await expect(imageSettled({ lock: '/run/x.lock', waitS: 7, exists: () => true, flock })).resolves.toBeUndefined();
    expect(flock.mock.calls[0][0]).toEqual(['--shared', '--timeout', '7', '/run/x.lock', '/usr/bin/true']);
    await expect(imageSettled({ exists: () => true, flock: async () => undefined })).resolves.toBeUndefined();
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
});
