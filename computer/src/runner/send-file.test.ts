import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { serveFiles } from './send-file-socket.js';
import { type FileUpload, fileSender, kindOf, type Posted } from './send-file.js';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../../bin/calvin-send-file');

describe('calvin-send-file', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'sf-ws-'));
  const sub = path.join(cwd, 'out');
  writeFileSync(path.join(cwd, 'secret.txt'), 'token=hunter2');
  const uploads: FileUpload[] = [];
  const posted: Posted[] = [];
  const send = fileSender(cwd, async (f) => void uploads.push(f), (b) => (b.includes('hunter2') ? 'TOKEN' : undefined), (p) => posted.push(p));
  const run_ = mkdtempSync(path.join(os.tmpdir(), 'sf-run-'));
  const socket = path.join(run_, 'r.files');
  const server = serveFiles(socket, send);
  afterAll(() => {
    server.close();
    for (const d of [cwd, run_]) rmSync(d, { recursive: true, force: true });
  });
  const cli = (args: string[], dir = cwd) => run(BIN, args, { cwd: dir, env: { ...process.env, SP_FILES_SOCKET: socket } });

  it('posts a file named relative to the script’s directory; the loose words are the comment', async () => {
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, 'shot.png'), 'png');
    const { stdout } = await cli(['shot.png', 'the', 'new', '--title', 'Setup', 'page'], sub);
    expect(stdout).toBe('Posted shot.png to the thread.\n');
    expect(uploads.at(-1)).toMatchObject({ filename: 'shot.png', comment: 'the new page', title: 'Setup' });
    expect(uploads.at(-1)!.path.endsWith(path.join('out', 'shot.png'))).toBe(true);
    expect(posted.at(-1)).toEqual({ kind: 'image', bytes: 3, source: 'script' });
  });

  it('answers with the reason when the read itself fails, instead of leaving the script waiting', async () => {
    writeFileSync(path.join(cwd, 'noperm.png'), 'png');
    chmodSync(path.join(cwd, 'noperm.png'), 0);
    await expect(cli(['noperm.png'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EACCES') });
    await expect(cli(['shot.png', '--title'])).rejects.toMatchObject({ stderr: expect.stringContaining('--title needs a value') });
  });

  it('classifies what was posted by its extension', () => {
    expect(['a.PNG', 'b.mp4', 'c.pdf', 'd.log', 'e.bin'].map(kindOf)).toEqual(['image', 'video', 'pdf', 'text', 'other']);
  });

  it('refuses what the tool refuses, and exits 1 with the reason', async () => {
    const n = uploads.length;
    await expect(cli(['/etc/hostname'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('only files inside the workspace') });
    await expect(cli(['secret.txt'])).rejects.toMatchObject({ stderr: expect.stringContaining('secret $TOKEN') });
    expect(uploads.length).toBe(n);
  });

  it('says where it works when not in a session', async () => {
    await expect(run(BIN, ['x.png'], { env: { ...process.env, SP_FILES_SOCKET: '' } })).rejects.toMatchObject({
      stderr: expect.stringContaining('inside a Calvin session'),
    });
  });
});
