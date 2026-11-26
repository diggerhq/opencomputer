import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLock, LockError } from './journal-lock.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlock-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('FileLock', () => {
  it('is exclusive, and taken again after release', async () => {
    const f = path.join(dir, 'a');
    fs.writeFileSync(f, '');
    const a = await FileLock.take(f);
    await expect(FileLock.take(f)).rejects.toMatchObject({ code: 'locked' });
    await a.release();
    const b = await FileLock.take(f);
    await b.release();
  });

  it('waits for a holder that releases within waitMs', async () => {
    const f = path.join(dir, 'b');
    fs.writeFileSync(f, '');
    const a = await FileLock.take(f);
    setTimeout(() => void a.release(), 100);
    const t0 = Date.now();
    const b = await FileLock.take(f, 3000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    await b.release();
  });

  it('is dropped when the holding process dies (SIGKILL)', async () => {
    const f = path.join(dir, 'c');
    fs.writeFileSync(f, '');
    // A child node process takes the lock, says so, and is killed.
    const script = `import('${path.resolve('src/api/journal-lock.ts').replace(/'/g, "\\'")}').then(async (m) => { await m.FileLock.take(${JSON.stringify(f)}); console.log('held'); setInterval(() => {}, 1000); });`;
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => d.toString().includes('held') && resolve());
      child.once('exit', (c) => reject(new Error(`child exited ${c}`)));
    });
    await expect(FileLock.take(f)).rejects.toBeInstanceOf(LockError);
    child.kill('SIGKILL');
    const b = await FileLock.take(f, 3000);
    await b.release();
  }, 15_000);

  it('fails (not locked) when flock is missing', async () => {
    const f = path.join(dir, 'd');
    fs.writeFileSync(f, '');
    await expect(FileLock.take(f, 0, '/nonexistent/flock')).rejects.toMatchObject({ code: 'failed' });
  });
});
