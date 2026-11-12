import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_PORTS, PREVIEW_PROXY_PORT } from '../preview-proxy.js';
import { PREVIEWS_PER_SANDBOX, VIRTUAL_PORTS, previewPorts } from './preview-ports.js';

const file = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'sp-ports-')), 'state', 'previews.json');

describe('virtual preview ports', () => {
  it('has a range that holds none of the host\'s own ports', () => {
    for (const p of [...HOST_PORTS, PREVIEW_PROXY_PORT]) expect(p < VIRTUAL_PORTS.first || p > VIRTUAL_PORTS.last, String(p)).toBe(true);
    expect(VIRTUAL_PORTS).toEqual({ first: 30000, last: 39999 });
  });

  it('gives two sessions on the same port a number each, and the same pair its own again', () => {
    const t = previewPorts(file());
    const a = t.assign('aaaa', 5173);
    const b = t.assign('bbbb', 5173);
    expect(a).toEqual({ entry: { virtual: 30000, id: 'aaaa', port: 5173 }, fresh: true });
    expect(b.entry.virtual).toBe(30001);
    expect(t.assign('aaaa', 5173)).toEqual({ entry: a.entry, fresh: false });
    expect(t.get(30001)).toMatchObject({ id: 'bbbb', port: 5173 });
    expect(t.get(30002)).toBeUndefined();
  });

  it('goes round the range: a freed number is not the next one given', () => {
    const t = previewPorts(file(), { first: 100, last: 102 });
    expect(t.assign('a', 1).entry.virtual).toBe(100);
    expect(t.assign('a', 2).entry.virtual).toBe(101);
    t.release(100);
    expect(t.assign('b', 1).entry.virtual).toBe(102);
    expect(t.assign('b', 2).entry.virtual).toBe(100); // wrapped
    expect(() => t.assign('c', 1)).toThrow(/every preview port/);
    t.release(101);
    expect(t.assign('c', 1).entry.virtual).toBe(101);
  });

  it('setName: a name is one entry\'s; an entry that held it is freed, on disk too', () => {
    const f = file();
    const t = previewPorts(f);
    const a = t.assign('aaaa', 5173).entry;
    const b = t.assign('bbbb', 3000).entry;
    t.setName(a.virtual, 'demo');
    t.setName(b.virtual, 'demo');
    expect(t.all()).toEqual([{ virtual: b.virtual, id: 'bbbb', port: 3000, name: 'demo' }]);
    expect(t.byName('demo')?.id).toBe('bbbb');
    expect(previewPorts(f).all()).toEqual(t.all());
    t.setName(b.virtual, 'demo'); // its own again: nothing changes
    expect(t.all()).toHaveLength(1);
  });

  it('gives one sandbox at most PREVIEWS_PER_SANDBOX numbers, whatever the others hold', () => {
    const t = previewPorts(file());
    expect(PREVIEWS_PER_SANDBOX).toBe(32);
    for (let p = 1; p <= PREVIEWS_PER_SANDBOX; p++) t.assign('a', 3000 + p);
    expect(() => t.assign('a', 4000)).toThrow('this session has 32 previews, the most it can have; unpreview one first');
    expect(t.all().length).toBe(32);
    // One it has already is still its own, and another sandbox is not held back.
    expect(t.assign('a', 3001).fresh).toBe(false);
    expect(t.assign('b', 4000).fresh).toBe(true);
    t.release(t.assign('a', 3002).entry.virtual);
    expect(t.assign('a', 4000).fresh).toBe(true);
  });

  it('finds and frees by name, and frees all of a sandbox', () => {
    const t = previewPorts(file());
    const a = t.assign('a', 3000).entry;
    t.assign('a', 3001);
    const b = t.assign('b', 3000).entry;
    t.setName(a.virtual, 'demo');
    expect(t.byName('demo')).toMatchObject({ id: 'a', port: 3000 });
    expect(t.byName('none')).toBeUndefined();
    expect(t.releaseAll('a')).toBe(2);
    expect(t.all()).toEqual([b]);
    expect(t.releaseAll('a')).toBe(0);
  });

  it('keeps the table and its place in the round across a restart, in a 0600 file', () => {
    const f = file();
    const t = previewPorts(f);
    const a = t.assign('a', 3000).entry;
    t.setName(a.virtual, 'demo');
    t.assign('b', 3000);
    t.release(30001);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const again = previewPorts(f);
    expect(again.all()).toEqual([{ virtual: 30000, id: 'a', port: 3000, name: 'demo' }]);
    expect(again.assign('c', 80).entry.virtual).toBe(30002);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ next: 30003 });
  });

  it('reads a file that does not parse, or holds a bad entry, as empty', () => {
    const f = file();
    previewPorts(f);
    writeFileSync(f, '{"entries":[{"virtual":7070,"id":"a","port":80}]}');
    expect(previewPorts(f).all()).toEqual([]);
    writeFileSync(f, 'not json');
    const t = previewPorts(f);
    expect(t.all()).toEqual([]);
    expect(t.assign('a', 80).entry.virtual).toBe(30000);
  });
});
