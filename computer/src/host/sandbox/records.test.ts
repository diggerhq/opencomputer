import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SandboxRecord, sandboxRecords } from './records.js';

let dir: string;
beforeEach(() => void (dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'records-')), 'sandboxes')));
afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

const rec = (id: string, over: Partial<SandboxRecord> = {}): SandboxRecord =>
  ({ id, person: 'U1', key: 'slack:C1:1.2', createdAt: '2026-11-12T00:00:00.000Z', usedAt: '2026-11-12T00:00:00.000Z', ...over });
const A = '00000000000000aa';
const B = '00000000000000bb';

describe('sandbox records', () => {
  it('makes its directory for the host alone', () => {
    sandboxRecords(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('finds a thread by person and key, and survives a restart', () => {
    const r = sandboxRecords(dir);
    r.write(rec(A));
    r.write(rec(B, { person: 'U2' }));
    expect(r.find('U1', 'slack:C1:1.2')?.id).toBe(A);
    expect(r.find('U2', 'slack:C1:1.2')?.id).toBe(B);
    expect(r.find('U1', 'other')).toBeUndefined();
    const again = sandboxRecords(dir);
    expect(again.all().map((x) => x.id).sort()).toEqual([A, B]);
    expect(again.get(A)).toEqual(rec(A));
  });

  it('writes by rename and leaves no temporary file', () => {
    const r = sandboxRecords(dir);
    r.write(rec(A));
    r.write(rec(A, { usedAt: '2026-11-13T00:00:00.000Z', repos: { web: { branch: 'sp/x', from: 'abc', base: 'main' } } }));
    expect(readdirSync(dir)).toEqual([`${A}.json`]);
    expect(statSync(path.join(dir, `${A}.json`)).mode & 0o777).toBe(0o600);
    expect(sandboxRecords(dir).get(A)?.repos?.web.base).toBe('main');
  });

  it('deletes', () => {
    const r = sandboxRecords(dir);
    r.write(rec(A));
    r.delete(A);
    expect(r.get(A)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ignores what is not a record, and refuses an id that is not one', () => {
    const r0 = sandboxRecords(dir);
    writeFileSync(path.join(dir, `${A}.json`), '{"id":"other"}');
    writeFileSync(path.join(dir, `${B}.json.123.tmp`), '{');
    writeFileSync(path.join(dir, 'notes.json'), '{}');
    expect(sandboxRecords(dir).all()).toEqual([]);
    expect(() => r0.write(rec('../x'))).toThrow(/bad sandbox id/);
  });
});
