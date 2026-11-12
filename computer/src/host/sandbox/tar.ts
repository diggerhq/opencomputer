// A tar stream of a few small text files (work 103): how the host gives a
// thread's workspace its root files (.fork.json, AGENTS.md) without writing
// there itself. bin/ws-add.sh unpacks it inside the thread's container, as
// the session's user.
//
// Invariants:
// - Plain ustar: regular files, mode 0644, no owner names; a name is a
//   relative path of at most 100 bytes with no `..` and no leading `/`.
// - Pure: the same files give the same bytes but for the time given.

const BLOCK = 512;

export interface TarFile {
  /** Relative to where it is unpacked. */
  name: string;
  text: string;
}

function header(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  const field = (at: number, len: number, value: string) => void h.write(value, at, len, 'utf8');
  const octal = (at: number, len: number, n: number) => field(at, len, n.toString(8).padStart(len - 1, '0') + '\0');
  field(0, 100, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, mtime);
  h.fill(' ', 148, 156); // the checksum counts its own field as spaces
  h.write('0', 156); // a regular file
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  let sum = 0;
  for (const b of h) sum += b;
  field(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

/** The files as one tar stream. `now`: their modification time, Unix milliseconds. */
export function tarOf(files: TarFile[], now = Date.now()): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const segments = f.name.split('/');
    if (!f.name || f.name.startsWith('/') || segments.some((p) => !p || p === '.' || p === '..') || Buffer.byteLength(f.name) > 100)
      throw new Error(`not a name for a tar entry: ${f.name}`);
    const body = Buffer.from(f.text, 'utf8');
    parts.push(header(f.name, body.length, Math.floor(now / 1000)), body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}
