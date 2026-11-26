// The Codex CLI's native binaries read into the page cache at host start
// (work 082): the first Codex session after a boot otherwise pages in about
// 370 MB as it starts (`initialize` 2.7–3.3 s against about 25 ms warm).
//
// Invariants: reads only, in the background, one file at a time; never
// fails the host (a missing or partial install is logged and skipped).
// After a host restart the files are already cached, so it costs a cached read.

import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

/** The package's native executables: the launcher `bin` is `<package>/bin/codex.js`; npm puts the platform's under vendor/. */
export async function codexNatives(bin: string): Promise<string[]> {
  if (!existsSync(bin)) return [];
  const root = path.dirname(path.dirname(realpathSync(bin)));
  const found: string[] = [];
  for (const p of ['vendor/*/bin/*', 'node_modules/@openai/*/vendor/*/bin/*']) for await (const f of glob(p, { cwd: root })) found.push(path.join(root, f));
  return found.sort();
}

/** Read each native executable once; resolves with the bytes read. */
export async function prereadCodex(bin: string): Promise<number> {
  let bytes = 0;
  const sink = () => new Writable({ write: (c: Buffer, _e, done) => ((bytes += c.length), done()) });
  for (const f of await codexNatives(bin)) await pipeline(createReadStream(f, { highWaterMark: 1 << 20 }), sink());
  return bytes;
}
