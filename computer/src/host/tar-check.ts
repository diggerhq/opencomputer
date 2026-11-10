// Checks an uploaded tar archive as it streams through (work 084; opc docs
// http/workspace.mdx, "Upload"), so `tar -x` only ever sees entries that stay
// inside the upload's directory. A Transform: bytes pass through unchanged
// while the headers are parsed; a refused entry or a limit errors the stream.
//
// Invariants:
// - Refused with `invalid_archive` (`entry` names it): absolute paths, `..`
//   segments, hard links, device files and FIFOs, unknown entry types, a
//   symlink whose target leaves the archive's root, an entry beneath a symlink
//   the archive made, and anything that is not a tar archive.
// - Refused with `too_large` (`bytes`, `files`): over `maxBytes` of file
//   content or `maxFiles` entries.
// - ustar, GNU long names (`L`/`K`) and pax headers (`x`; `g` is ignored) are
//   understood; the name an entry gets is the one tar will use.

import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import type { ApiError } from '../protocol.js';
import { apiError } from '../api/writer.js';

export const UPLOAD_MAX_BYTES = 1024 ** 3;
export const UPLOAD_MAX_FILES = 100_000;
const BLOCK = 512;

export interface TarCheckResult {
  files: number;
  bytes: number;
}

export class TarError extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

const invalid = (message: string, entry?: string) => new TarError(apiError('invalid_archive', message, 400, entry === undefined ? {} : { entry }));

/** Where `p` lands relative to the root, or undefined if it leaves it. */
function inside(p: string): string | undefined {
  if (p.startsWith('/') || p.includes('\0')) return undefined;
  const n = path.posix.normalize(p);
  if (n === '..' || n.startsWith('../')) return undefined;
  return n.replace(/\/+$/, '').replace(/^\.\/?/, '');
}

function octal(b: Buffer): number {
  // GNU base-256 for sizes over 8 GiB: always over the limit here.
  if (b[0] & 0x80) return Number.MAX_SAFE_INTEGER;
  const s = b.toString('latin1').replace(/\0.*$/s, '').trim();
  return s ? Number.parseInt(s, 8) : 0;
}

const cstr = (b: Buffer) => {
  const z = b.indexOf(0);
  return (z < 0 ? b : b.subarray(0, z)).toString('utf8');
};

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === octal(h.subarray(148, 156));
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(body.subarray(i, sp).toString('latin1'));
    if (!Number.isInteger(len) || len <= 0 || i + len > body.length) break;
    const rec = body.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export class TarCheck extends Transform {
  readonly result: TarCheckResult = { files: 0, bytes: 0 };
  private buf: Buffer = Buffer.alloc(0);
  /** Bytes of the current entry's body (and padding) still to skip, or to collect for `L`/`K`/`x`. */
  private skip = 0;
  private collect: { kind: string; size: number; parts: Buffer[]; got: number } | undefined;
  private longName: string | undefined;
  private longLink: string | undefined;
  private pax: Record<string, string> = {};
  private links = new Set<string>();
  private ended = false;
  private zeroBlocks = 0;

  constructor(
    private readonly maxBytes = UPLOAD_MAX_BYTES,
    private readonly maxFiles = UPLOAD_MAX_FILES,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    try {
      this.scan(chunk);
    } catch (e) {
      return cb(e as Error);
    }
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback) {
    if (!this.ended && (this.result.files === 0 || this.skip > 0 || this.collect || this.buf.length > 0)) {
      return cb(this.result.files === 0 ? invalid('The body is not a tar archive.') : invalid('The archive is truncated.'));
    }
    cb();
  }

  private scan(chunk: Buffer) {
    let data = chunk;
    while (data.length > 0) {
      if (this.ended) return;
      if (this.collect) {
        const c = this.collect;
        const take = Math.min(data.length, c.size - c.got);
        c.parts.push(data.subarray(0, take));
        c.got += take;
        data = data.subarray(take);
        if (c.got === c.size) this.finishCollect();
        continue;
      }
      if (this.skip > 0) {
        const take = Math.min(this.skip, data.length);
        this.skip -= take;
        data = data.subarray(take);
        continue;
      }
      const need = BLOCK - this.buf.length;
      this.buf = Buffer.concat([this.buf, data.subarray(0, need)]);
      data = data.subarray(Math.min(need, data.length));
      if (this.buf.length < BLOCK) return;
      const h = this.buf;
      this.buf = Buffer.alloc(0);
      this.header(h);
    }
  }

  private finishCollect() {
    const c = this.collect;
    if (!c) return;
    this.collect = undefined;
    const body = Buffer.concat(c.parts);
    if (c.kind === 'L') this.longName = cstr(body);
    else if (c.kind === 'K') this.longLink = cstr(body);
    else if (c.kind === 'x') this.pax = parsePax(body);
    this.skip = (BLOCK - (c.size % BLOCK)) % BLOCK;
  }

  private header(h: Buffer) {
    if (h.every((b) => b === 0)) {
      if (++this.zeroBlocks >= 2) this.ended = true;
      return;
    }
    this.zeroBlocks = 0;
    if (!checksumOk(h)) throw invalid(this.result.files === 0 ? 'The body is not a tar archive.' : 'A tar header is corrupt.');
    const type = String.fromCharCode(h[156] || 0x30);
    const size = octal(h.subarray(124, 136));
    if (type === 'L' || type === 'K' || type === 'x') {
      if (size > 1 << 20) throw invalid('A tar header is too long.');
      this.collect = { kind: type, size, parts: [], got: 0 };
      if (size === 0) this.finishCollect();
      return;
    }
    if (type === 'g') {
      this.skip = Math.ceil(size / BLOCK) * BLOCK;
      return;
    }
    const prefix = h.subarray(257, 263).toString('latin1').startsWith('ustar') ? cstr(h.subarray(345, 500)) : '';
    const raw = this.pax.path ?? this.longName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
    const linkTarget = this.pax.linkpath ?? this.longLink ?? cstr(h.subarray(157, 257));
    this.pax = {};
    this.longName = undefined;
    this.longLink = undefined;

    const name = inside(raw);
    if (name === undefined || raw.split('/').includes('..')) throw invalid('Entries may not have absolute paths or "..".', raw);
    for (let p = path.posix.dirname(name); p !== '.' && p !== ''; p = path.posix.dirname(p)) {
      if (this.links.has(p)) throw invalid('An entry is beneath a symbolic link.', raw);
    }
    switch (type) {
      case '0':
      case '7':
        this.result.bytes += size;
        break;
      case '5':
        break;
      case '2': {
        const target = linkTarget.startsWith('/') ? undefined : inside(path.posix.join(path.posix.dirname(name), linkTarget));
        if (target === undefined) throw invalid('A symbolic link points outside the archive.', raw);
        this.links.add(name);
        break;
      }
      case '1':
        throw invalid('Hard links are refused.', raw);
      case '3':
      case '4':
      case '6':
        throw invalid('Device files and FIFOs are refused.', raw);
      default:
        throw invalid(`Entry type ${JSON.stringify(type)} is refused.`, raw);
    }
    this.result.files += 1;
    if (this.result.files > this.maxFiles || this.result.bytes > this.maxBytes) {
      throw new TarError(apiError('too_large', 'The archive is over 1 GiB or 100,000 files, unpacked.', 413, { bytes: this.result.bytes, files: this.result.files }));
    }
    this.skip = type === '0' || type === '7' ? Math.ceil(size / BLOCK) * BLOCK : 0;
  }
}
