// Virtual preview ports (work 103, C9): the gateway and the previews Worker
// key a preview by its port, and two sessions in containers can both serve
// 5173. So the host gives each previewed `(sandbox id, port)` a number of its
// own in 30000–39999, tells the gateway that number, and the proxy maps it
// back to the session and its port (previews.ts).
//
// Invariants:
// - One number per `(id, port)`, and one entry per number.
// - A new number is the next free one after the last handed out, wrapping
//   round: never the lowest free, so a number just freed is not given to
//   another session while a public name may still point at it. The place in
//   the round is saved with the entries, so a host restart keeps it.
// - One sandbox holds at most PREVIEWS_PER_SANDBOX numbers, so no session can
//   use the range up for the others: one preview more fails, and says so.
// - The table is in memory and in `$SP_DATA/state/previews.json` (0600,
//   written whole to a temporary file and renamed). A file that does not
//   parse is logged and read as empty: the names it held answer "port not
//   previewed" until their sessions call `preview` again.
// - The range holds none of the host's own ports (preview-proxy.ts
//   `HOST_PORTS`); the unit test asserts it.

import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { log } from '../../log.js';

export const VIRTUAL_PORTS = { first: 30000, last: 39999 } as const;
/** The most numbers one sandbox holds at a time. */
export const PREVIEWS_PER_SANDBOX = 32;

export interface PreviewEntry {
  /** What the gateway, the Worker and the proxy's `X-Preview-Port` call this preview. */
  virtual: number;
  /** The sandbox (its runner's id). */
  id: string;
  /** The port inside that sandbox. */
  port: number;
  /** The public name, once the gateway gave one. */
  name?: string;
}

export interface PreviewPorts {
  /** The entry of `(id, port)`: its own when it has one (`fresh` false), else a new number. Throws when `id` has as many as it may, or the range is used up. */
  assign(id: string, port: number): { entry: PreviewEntry; fresh: boolean };
  get(virtual: number): PreviewEntry | undefined;
  byName(name: string): PreviewEntry | undefined;
  setName(virtual: number, name: string): void;
  release(virtual: number): void;
  /** Free every entry of a sandbox (Remove); how many there were. */
  releaseAll(id: string): number;
  all(): PreviewEntry[];
}

const inRange = (n: unknown, r: { first: number; last: number }): n is number => Number.isInteger(n) && (n as number) >= r.first && (n as number) <= r.last;

function read(file: string, range: { first: number; last: number }): { next: number; entries: PreviewEntry[] } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { next: range.first, entries: [] }; // no file yet
  }
  try {
    const j = JSON.parse(text) as { next?: unknown; entries?: unknown };
    if (!Array.isArray(j.entries)) throw new Error('no entries');
    const entries: PreviewEntry[] = [];
    for (const e of j.entries as Partial<PreviewEntry>[]) {
      if (!inRange(e?.virtual, range) || typeof e.id !== 'string' || !inRange(e.port, { first: 1, last: 65535 })) throw new Error('a bad entry');
      entries.push({ virtual: e.virtual, id: e.id, port: e.port, ...(typeof e.name === 'string' && { name: e.name }) });
    }
    return { next: inRange(j.next, range) ? j.next : range.first, entries };
  } catch (e) {
    log.warn(`preview ports: ${file} not read (${(e as Error)?.message ?? e}); starting empty`);
    return { next: range.first, entries: [] };
  }
}

/** The table kept in `file`, read now. `range`: tests pass a small one. */
export function previewPorts(file: string, range: { first: number; last: number } = VIRTUAL_PORTS): PreviewPorts {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const loaded = read(file, range);
  let next = loaded.next;
  const byVirtual = new Map<number, PreviewEntry>();
  for (const e of loaded.entries) byVirtual.set(e.virtual, e);

  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ next, entries: [...byVirtual.values()] }, null, 1) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  }
  const find = (f: (e: PreviewEntry) => boolean) => [...byVirtual.values()].find(f);

  return {
    assign(id, port) {
      const have = find((e) => e.id === id && e.port === port);
      if (have) return { entry: have, fresh: false };
      let mine = 0;
      for (const e of byVirtual.values()) if (e.id === id) mine++;
      if (mine >= PREVIEWS_PER_SANDBOX) throw new Error(`this session has ${mine} previews, the most it can have; unpreview one first`);
      const size = range.last - range.first + 1;
      for (let i = 0; i < size; i++) {
        const virtual = range.first + ((next - range.first + i) % size);
        if (byVirtual.has(virtual)) continue;
        const entry: PreviewEntry = { virtual, id, port };
        byVirtual.set(virtual, entry);
        next = virtual === range.last ? range.first : virtual + 1;
        save();
        return { entry, fresh: true };
      }
      throw new Error(`every preview port of this computer is in use (${size}); unpreview one first`);
    },
    get: (virtual) => byVirtual.get(virtual),
    byName: (name) => find((e) => e.name === name),
    setName(virtual, name) {
      const e = byVirtual.get(virtual);
      if (!e || e.name === name) return;
      e.name = name;
      save();
    },
    release(virtual) {
      if (byVirtual.delete(virtual)) save();
    },
    releaseAll(id) {
      const mine = [...byVirtual.values()].filter((e) => e.id === id);
      for (const e of mine) byVirtual.delete(e.virtual);
      if (mine.length) save();
      return mine.length;
    },
    all: () => [...byVirtual.values()],
  };
}
