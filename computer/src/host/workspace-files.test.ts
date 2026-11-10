import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentType, createWorkspaceFiles, type Workspace, type WorkspaceFiles } from './workspace-files.js';

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
