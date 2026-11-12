import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentType, createWorkspaceFiles, parseListing, type Workspace, type WorkspaceFiles } from './workspace-files.js';

let root: string;
let ws: Workspace;
let files: WorkspaceFiles;
const actor = { id: 'usr_a', name: 'A', via: 'opc', client: 'opc/0.1.0' };

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wsfiles-'));
  const fork = path.join(root, 'fork');
  mkdirSync(path.join(fork, 'repo/.git'), { recursive: true });
  mkdirSync(path.join(fork, 'repo/src'), { recursive: true });
  writeFileSync(path.join(fork, 'repo/.git/HEAD'), 'ref');
  writeFileSync(path.join(fork, 'repo/src/a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(fork, 'repo/README.md'), '# hi\n');
  writeFileSync(path.join(fork, 'repo/bin.dat'), Buffer.from([1, 0, 2]));
  symlinkSync('/etc', path.join(fork, 'escape'));
  ws = { sessionId: 'cs_t', forkPath: fork };
  files = createWorkspaceFiles({ dir: path.join(root, 'scratch') });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const tarOf = (dir: string) => execFileSync('tar', ['-c', '-C', dir, '.']);
const body = (b: Buffer) => Readable.from([b]);
const collect = async (r: Readable) => {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(c as Buffer);
  return Buffer.concat(parts);
};

describe('list', () => {
  it('lists in path order, a directory before its contents, never into .git', async () => {
    const r = await files.list(ws, { path: 'repo', depth: 3, limit: 100 });
    if ('error' in r) throw new Error(r.error.code);
    expect(r.entries.map((e) => `${e.type}:${e.path}`)).toEqual(['dir:repo/.git', 'file:repo/README.md', 'file:repo/bin.dat', 'dir:repo/src', 'file:repo/src/a.ts']);
    expect(r.entries[1].bytes).toBe(5);
    expect(r.nextCursor).toBeNull();
  });

  it('pages with a cursor', async () => {
    const one = await files.list(ws, { path: 'repo', depth: 2, limit: 2 });
    if ('error' in one) throw new Error();
    expect(one.entries).toHaveLength(2);
    const two = await files.list(ws, { path: 'repo', depth: 2, limit: 2, cursor: one.nextCursor as string });
    if ('error' in two) throw new Error();
    expect(two.entries.map((e) => e.path)).toEqual(['repo/bin.dat', 'repo/src']);
    const bad = await files.list(ws, { path: '', depth: 2, limit: 2, cursor: one.nextCursor as string });
    expect('error' in bad && bad.error.code).toBe('invalid_cursor');
  });

  it('refuses paths that leave the workspace', async () => {
    for (const p of ['../x', '/etc', 'escape']) {
      const r = await files.list(ws, { path: p });
      expect('error' in r && r.error.code, p).toBe('invalid_path');
    }
    const r = await files.list(ws, { path: 'nope' });
    expect('error' in r && r.error.code).toBe('path_not_found');
  });
});

describe('file', () => {
  it('reads one file with a type and an etag', async () => {
    const r = await files.file(ws, 'repo/README.md');
    if ('error' in r) throw new Error(r.error.code);
    expect(r).toMatchObject({ size: 5, contentType: 'text/markdown; charset=utf-8' });
    const s = r.read();
    expect((await collect(s.stream)).toString()).toBe('# hi\n');
    await s.done;
    const again = await files.file(ws, 'repo/README.md');
    expect('etag' in again && again.etag).toBe(r.etag);
    const dir = await files.file(ws, 'repo');
    expect('error' in dir && dir.error.code).toBe('path_not_found');
  });

  it('guesses types without rendering HTML', () => {
    expect(contentType('x.bin', Buffer.from([0, 1]))).toBe('application/octet-stream');
    expect(contentType('page.html', Buffer.from('<html>'))).toBe('text/plain; charset=utf-8');
    expect(contentType('x.png', Buffer.alloc(0))).toBe('image/png');
  });
});

describe('archive', () => {
  it('archives a directory without .git, paths relative to it', async () => {
    const r = await files.archive(ws, 'repo');
    if ('error' in r) throw new Error(r.error.code);
    const s = r.read();
    const tar = await collect(s.stream);
    await s.done;
    const out = path.join(root, 'out');
    mkdirSync(out);
    execFileSync('tar', ['-x', '-C', out], { input: tar });
    expect(existsSync(path.join(out, '.git'))).toBe(false);
    expect(readFileSync(path.join(out, 'src/a.ts'), 'utf8')).toContain('a = 1');
  });
});

describe('upload', () => {
  function srcDir(content: string) {
    const src = path.join(root, `src-${Math.random()}`);
    mkdirSync(path.join(src, 'lib'), { recursive: true });
    writeFileSync(path.join(src, 'lib/x.txt'), content);
    return src;
  }

  it('unpacks beside the repositories, then replaces on a re-push', async () => {
    const one = await files.upload(ws, 'billing', 'tar+zstd', actor, body(zlib.zstdCompressSync(tarOf(srcDir('v1')))));
    if ('error' in one) throw new Error(one.error.message);
    expect(one.upload).toMatchObject({ path: 'billing', bytes: 2, replaced: null });
    expect(readFileSync(path.join(ws.forkPath, 'billing/lib/x.txt'), 'utf8')).toBe('v1');

    const two = await files.upload(ws, 'billing', 'tar+gzip', actor, body(zlib.gzipSync(tarOf(srcDir('v2')))));
    if ('error' in two) throw new Error(two.error.message);
    expect(two.upload.replaced).toMatchObject({ pushedBy: actor });
    expect(readFileSync(path.join(ws.forkPath, 'billing/lib/x.txt'), 'utf8')).toBe('v2');
    expect(readdirSync(ws.forkPath).filter((n) => n.startsWith('.opc-'))).toEqual([]);

    const list = await files.list(ws, { path: '' });
    if ('error' in list) throw new Error();
    expect(list.entries.find((e) => e.path === 'billing')).toMatchObject({ pushedBy: actor });
    expect(list.entries.find((e) => e.path === 'repo')).toMatchObject({ pushedAt: null });
  });

  it('takes an archive whose unpacking ends before its last bytes are written', async () => {
    // tar stops at the end-of-archive mark and exits; what follows (padding) is then written to nobody.
    const padded = Buffer.concat([tarOf(srcDir('v1')), Buffer.alloc(8 * 2 ** 20)]);
    for (let i = 0; i < 5; i++) {
      const r = await files.upload(ws, 'padded', 'tar', actor, Readable.from([padded.subarray(0, 4096), padded.subarray(4096)]));
      if ('error' in r) throw new Error(r.error.message);
      expect(readFileSync(path.join(ws.forkPath, 'padded/lib/x.txt'), 'utf8')).toBe('v1');
    }
  });

  it('never overwrites what was not uploaded', async () => {
    const r = await files.upload(ws, 'repo', 'tar', actor, body(tarOf(srcDir('x'))));
    expect('error' in r && r.error.code).toBe('path_exists');
    expect(await files.canUpload(ws, 'repo')).toMatchObject({ error: { code: 'path_exists' } });
  });

  it('a bad archive changes nothing', async () => {
    const r = await files.upload(ws, 'junk', 'tar', actor, body(Buffer.from('nope'.repeat(300))));
    expect('error' in r && r.error.code).toBe('invalid_archive');
    const z = await files.upload(ws, 'junk', 'tar+zstd', actor, body(Buffer.from('not zstd')));
    expect('error' in z && z.error.code).toBe('invalid_archive');
    expect(existsSync(path.join(ws.forkPath, 'junk'))).toBe(false);
    expect(readdirSync(ws.forkPath).filter((n) => n.startsWith('.opc-'))).toEqual([]);
  });
});

describe('an upload that is cut (work 103, C13)', () => {
  const opc = () => readdirSync(ws.forkPath).filter((n) => n.startsWith('.opc-'));
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A place whose `mkdir` takes `ms`: a machine under load, where the script has not made its directory when its upload fails. */
  function slowMkdir(ms: number) {
    const bin = path.join(root, 'slow-bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'mkdir'), `#!/bin/sh\nsleep ${ms / 1000}\nexec /bin/mkdir "$@"\n`, { mode: 0o755 });
    return createWorkspaceFiles({
      dir: path.join(root, 'scratch-slow'),
      place: (w) => ({
        root: w.forkPath,
        spawn: (argv) => spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }),
      }),
    });
  }

  it('leaves no directory when the body fails before the script made its own', async () => {
    const f = slowMkdir(300);
    const r = await f.upload(ws, 'junk', 'tar', actor, body(Buffer.from('nope'.repeat(300))));
    expect('error' in r && r.error.code).toBe('invalid_archive');
    await settle(600);
    expect(opc()).toEqual([]);
  });

  it('leaves none when the body stops halfway, and the next upload removes what an earlier one could not', async () => {
    const big = path.join(root, 'big');
    mkdirSync(big);
    writeFileSync(path.join(big, 'a.bin'), Buffer.alloc(300_000, 7));
    const tar = tarOf(big);
    const cut = new Readable({ read() {} });
    cut.push(tar.subarray(0, 100_000));
    const up = files.upload(ws, 'half', 'tar', actor, cut);
    await settle(200);
    cut.destroy(new Error('the request ended'));
    expect(await up).toMatchObject({ error: { code: 'invalid_archive' } });
    expect(opc()).toEqual([]);
    // What a script that was killed outright left (the container stopped, the machine went down).
    mkdirSync(path.join(ws.forkPath, '.opc-upload-half-0000'));
    mkdirSync(path.join(ws.forkPath, '.opc-replaced-half-0000'));
    expect(await files.upload(ws, 'half', 'tar', actor, body(tar))).toMatchObject({ upload: { path: 'half', bytes: 300_000 } });
    expect(opc()).toEqual([]);
  });
});

describe('where the scripts run (work 103, C13)', () => {
  /** A place whose root is the fork under another name: what a container's /workspace is to the host's path. */
  function elsewhere() {
    const started: { script: string; args: string[]; write?: boolean; stdin?: boolean }[] = [];
    const inside = path.join(root, 'inside');
    symlinkSync(ws.forkPath, inside);
    const f = createWorkspaceFiles({
      dir: path.join(root, 'scratch2'),
      place: () => ({
        root: inside,
        spawn(argv, mode) {
          started.push({ script: argv[2], args: argv.slice(3), ...mode });
          return spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
        },
      }),
    });
    return { f, started, nowhere: { sessionId: 'cs_t', forkPath: '/nonexistent/on/this/host' } };
  }

  it('reaches every file through the place, never through the host path, and nothing chosen by the caller is script text', async () => {
    const { f, started, nowhere } = elsewhere();
    const l = await f.list(nowhere, { path: 'repo', depth: 2 });
    expect('entries' in l && l.entries.map((e) => e.path)).toEqual(['repo/.git', 'repo/README.md', 'repo/bin.dat', 'repo/src', 'repo/src/a.ts']);
    const one = await f.file(nowhere, 'repo/README.md');
    if ('error' in one) throw new Error(one.error.code);
    expect((await collect(one.read().stream)).toString()).toBe('# hi\n');
    const a = await f.archive(nowhere, 'repo/src');
    expect(a).toMatchObject({ files: 2, bytes: 20 });
    const up = await f.upload(nowhere, 'pushed', 'tar', actor, body(tarOf(path.join(ws.forkPath, 'repo/src'))));
    expect(up).toMatchObject({ upload: { path: 'pushed', files: 2 } });
    expect(readFileSync(path.join(ws.forkPath, 'pushed/a.ts'), 'utf8')).toContain('export const a');
    for (const s of started) {
      expect(s.args[0]).toBe('sh');
      expect(s.args[1]).toBe(path.join(root, 'inside'));
      for (const word of ['repo', 'README', 'pushed']) expect(s.script.includes(word), word).toBe(false);
    }
    // Only an upload's scripts may change the workspace, and only its unpacking reads standard input.
    const writers = started.filter((s) => s.write);
    expect(writers.map((s) => s.args[2].replace(/-[0-9a-f]{12}$/, ''))).toEqual(['.opc-upload-pushed', '.opc-upload-pushed']);
    expect(started.filter((s) => s.stdin)).toHaveLength(1);
    expect(started.filter((s) => !s.write).length).toBeGreaterThanOrEqual(5);
  });

  it('holds a symlink to the place it is resolved in: outside is invalid_path for every read', async () => {
    const { f, nowhere } = elsewhere();
    symlinkSync('/etc/hostname', path.join(ws.forkPath, 'repo/leak'));
    symlinkSync('README.md', path.join(ws.forkPath, 'repo/alias'));
    for (const p of ['escape', 'repo/leak', 'escape/hostname']) {
      expect(await f.file(nowhere, p), p).toMatchObject({ error: { code: 'invalid_path' } });
      expect(await f.archive(nowhere, p), p).toMatchObject({ error: { code: 'invalid_path' } });
    }
    expect(await f.file(nowhere, 'repo/alias')).toMatchObject({ size: 5 });
    expect(await f.file(nowhere, 'repo/src')).toMatchObject({ error: { code: 'path_not_found' } });
    expect(await f.file(nowhere, 'repo/nope')).toMatchObject({ error: { code: 'path_not_found' } });
    expect(await f.canUpload(nowhere, '../x')).toMatchObject({ error: { code: 'invalid_path' } });
    expect(await f.canUpload(nowhere, '.hidden')).toMatchObject({ error: { code: 'invalid_path' } });
  });

  it('fails, and reads nothing on the host, when a workspace has no place', async () => {
    const f = createWorkspaceFiles({ dir: path.join(root, 'scratch3'), place: () => { throw new Error('session cs_t has no sandbox'); } });
    await expect(f.list(ws, { path: '' })).rejects.toThrow('no sandbox');
    await expect(f.file(ws, 'repo/README.md')).rejects.toThrow('no sandbox');
    await expect(f.canUpload(ws, 'x')).rejects.toThrow('no sandbox');
  });

  it('orders a listing by path components, whatever order find printed it in', () => {
    const rec = (y: string, p: string) => `${y}\t3\t1700000000.5000000000\t${p}\0`;
    const out = Buffer.from(rec('f', 'b') + rec('f', 'a/z') + rec('d', 'a') + rec('f', 'a.txt') + rec('l', 'a/b c\nd') + rec('f', 'B'));
    expect(parseListing(out).map((e) => `${e.type}:${e.rel}`)).toEqual(['file:B', 'dir:a', 'symlink:a/b c\nd', 'file:a/z', 'file:a.txt', 'file:b']);
    expect(parseListing(out)[0].modifiedAt).toBe('2023-11-14T22:13:20.500Z');
  });
});
