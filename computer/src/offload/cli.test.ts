// bin/oc-offload, run as a session runs it, against a fake offload socket and a fake object store.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = path.resolve('bin/oc-offload');

function run(args: string[], cwd: string, env: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** A tarball made in a scratch directory by `make`. */
function tgz(make: (dir: string) => void, args: string[] = ['.']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'art-'));
  make(dir);
  // -P keeps what --transform makes: GNU tar would otherwise strip a hostile `../`.
  return execFileSync('tar', ['-czPf', '-', '-C', dir, ...args]);
}

async function fakes(artifact: Buffer, exitCode = 0) {
  const uploads: Buffer[] = [];
  const store = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      if (req.method === 'PUT') return uploads.push(Buffer.concat(chunks)), res.end();
      res.end(artifact);
    });
  });
  await new Promise<void>((r) => store.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  const asked: Record<string, unknown>[] = [];
  const sock = path.join(mkdtempSync(path.join(os.tmpdir(), 'sock-')), 'a.offload.sock');
  const answer = (q: Record<string, unknown>) => {
    switch (q.op) {
      case 'health': return { ok: true, ready: true, sizes: ['s', 'm'], sourceMaxMb: 10 };
      case 'submit': return { ok: true, id: 'j0123456789abcdef', srcPutUrl: `${url}/put`, minutes: 5 };
      case 'start': return { ok: true };
      case 'logs': return { ok: true, data: q.offset === 0 ? Buffer.from('building\n').toString('base64') : '', next: 9, eof: q.offset !== 0 };
      case 'status': return { ok: true, job: { state: 'done', exitCode, artifactSha256: 'x' } };
      case 'fetch': return { ok: true, url: `${url}/get`, sha256: createHash('sha256').update(artifact).digest('hex') };
      default: return { ok: false, error: 'no', code: 'refused' };
    }
  };
  const srv = net.createServer((s) => {
    let b = '';
    s.on('data', (d) => {
      b += d;
      if (!b.includes('\n')) return;
      const q = JSON.parse(b.split('\n')[0]);
      asked.push(q);
      s.end(`${JSON.stringify(answer(q))}\n`);
    });
  });
  await new Promise<void>((r) => srv.listen(sock, r));
  return { sock, uploads, asked, close: () => (srv.close(), store.close()) };
}

describe('oc-offload', () => {
  it('says offload is not available (exit 3) without a socket', async () => {
    const r = await run(['--size', 's', '--', 'make'], os.tmpdir(), {});
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^offload not available on this host/);
  });
  it('uploads the tracked files, streams the log, unpacks the verified artifact, exits with the build\'s code', async () => {
    const art = tgz((d) => (mkdirSync(path.join(d, 'dist')), writeFileSync(path.join(d, 'dist', 'app'), 'built')), ['dist']);
    const f = await fakes(art, 7);
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(cwd, 'main.c'), 'int main(){}');
    mkdirSync(path.join(cwd, 'node_modules'));
    writeFileSync(path.join(cwd, 'node_modules', 'big'), 'x');
    const r = await run(['--size', 's', '--timeout', '5', '--artifact', 'dist', '--', 'make', 'all'], cwd, { SP_OFFLOAD_SOCKET: f.sock });
    f.close();
    expect(r.err).not.toMatch(/oc-offload: (?!job|unpacked)/);
    expect(r.code).toBe(7);
    expect(r.out).toBe('building\n');
    expect(f.asked.find((q) => q.op === 'submit')).toMatchObject({ size: 's', cmd: 'make all', artifacts: ['dist'], timeoutMin: 5 });
    const listed = execFileSync('tar', ['-tzf', '-'], { input: f.uploads[0] }).toString().split('\n').filter(Boolean).sort();
    expect(listed).toEqual(['.gitignore', 'main.c']);
    expect(readFileSync(path.join(cwd, 'dist', 'app'), 'utf8')).toBe('built');
  });
  it('refuses an artifact that would write outside the directory', async () => {
    for (const art of [
      tgz((d) => writeFileSync(path.join(d, 'evil'), 'x'), ['--transform', 's,^evil,../evil,', 'evil']),
      tgz((d) => symlinkSync('/etc', path.join(d, 'link')), ['link']),
    ]) {
      const f = await fakes(art);
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'repo-'));
      const r = await run(['--size', 's', '--artifact', 'out', '--', 'true'], cwd, { SP_OFFLOAD_SOCKET: f.sock });
      f.close();
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/artifact: (entry|link)/);
      expect(existsSync(path.join(cwd, 'link'))).toBe(false);
    }
  });
});
