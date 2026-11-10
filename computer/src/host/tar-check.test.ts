import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { TarCheck, TarError } from './tar-check.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tarcheck-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A ustar header for a crafted entry (what `tar` itself would refuse to write). */
function header(name: string, type: string, size = 0, link = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(link, 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const tarOf = (...entries: [string, string, string?, string?][]) =>
  Buffer.concat([
    ...entries.flatMap(([name, type, body = '', link = '']) => {
      const b = Buffer.from(body);
      return [header(name, type, b.length, link), b, Buffer.alloc((512 - (b.length % 512)) % 512)];
    }),
    Buffer.alloc(1024),
  ]);

async function check(buf: Buffer, maxBytes?: number, maxFiles?: number) {
  const c = new TarCheck(maxBytes, maxFiles);
  let passed = 0;
  const chunks = [];
  for (let i = 0; i < buf.length; i += 700) chunks.push(buf.subarray(i, i + 700));
  try {
    await pipeline(
      Readable.from(chunks),
      c,
      new Writable({
        write(chunk, _e, cb) {
          passed += chunk.length;
          cb();
        },
      }),
    );
    return { ok: true as const, ...c.result, passed };
  } catch (e) {
    if (!(e instanceof TarError)) throw e;
    return { ok: false as const, code: e.error.code, entry: e.error.entry, bytes: e.error.bytes };
  }
}

describe('TarCheck', () => {
  it('passes a real archive through unchanged and counts it', async () => {
    const src = path.join(tmp, 'src');
    mkdirSync(path.join(src, 'a/b'), { recursive: true });
    writeFileSync(path.join(src, 'a/b/f.txt'), 'hello');
    writeFileSync(path.join(src, `${'n'.repeat(150)}.txt`), 'long name');
    symlinkSync('b/f.txt', path.join(src, 'a/link'));
    for (const format of ['gnu', 'pax', 'ustar']) {
      if (format === 'ustar') rmSync(path.join(src, `${'n'.repeat(150)}.txt`), { force: true });
      const buf = execFileSync('tar', ['-c', `--format=${format}`, '-C', src, '.']);
      const r = await check(buf);
      expect(r, format).toMatchObject({ ok: true, passed: buf.length });
      if (r.ok) expect(r.bytes).toBe(format === 'ustar' ? 5 : 14);
    }
  });

  it.each([
    ['absolute path', tarOf(['/etc/x', '0', 'x']), '/etc/x'],
    ['.. segment', tarOf(['a/../../x', '0', 'x']), 'a/../../x'],
    ['hard link', tarOf(['a', '0', 'x'], ['b', '1', '', 'a']), 'b'],
    ['char device', tarOf(['dev', '3']), 'dev'],
    ['fifo', tarOf(['fifo', '6']), 'fifo'],
    ['symlink out', tarOf(['l', '2', '', '../../etc']), 'l'],
    ['absolute symlink', tarOf(['l', '2', '', '/etc']), 'l'],
    ['entry beneath a symlink', tarOf(['d', '2', '', 'x'], ['d/f', '0', 'x']), 'd/f'],
    ['unknown type', tarOf(['q', 'Q']), 'q'],
  ])('refuses %s', async (_name, buf, entry) => {
    expect(await check(buf)).toMatchObject({ ok: false, code: 'invalid_archive', entry });
  });

  it('refuses what is not tar, and a truncated archive', async () => {
    expect(await check(Buffer.from('not a tar file at all'.repeat(40)))).toMatchObject({ ok: false, code: 'invalid_archive' });
    const t = tarOf(['a', '0', 'x'.repeat(2000)]);
    expect(await check(t.subarray(0, 1024))).toMatchObject({ ok: false, code: 'invalid_archive' });
  });

  it('refuses over the limits with how much', async () => {
    expect(await check(tarOf(['a', '0', 'x'.repeat(100)], ['b', '0', 'y'.repeat(100)]), 150)).toMatchObject({ ok: false, code: 'too_large', bytes: 200 });
    expect(await check(tarOf(['a', '5'], ['b', '5'], ['c', '5']), undefined, 2)).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('allows a symlink that stays inside', async () => {
    expect(await check(tarOf(['d/', '5'], ['d/l', '2', '', '../f'], ['f', '0', 'x']))).toMatchObject({ ok: true, files: 3 });
  });
});
