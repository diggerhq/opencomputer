import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintId } from '../session-ids.js';
import { ensureJournalDir, ensureSessionJournalDir, journalPath } from './journal-dir.js';
import { saveResult } from './subagent-results.js';

let data: string;
let target: string;
beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'jdir-'));
  target = path.join(data, 'host-only');
  fs.mkdirSync(target, { mode: 0o700 });
});
afterEach(() => fs.rmSync(data, { recursive: true, force: true }));

const mode = (p: string) => fs.statSync(p).mode & 0o7777;

describe('journal directories', () => {
  it('a new journals directory is 02750; one that exists keeps the mode provisioning gave it', () => {
    expect(mode(ensureJournalDir(data))).toBe(0o2750);
    fs.chmodSync(path.join(data, 'journals'), 0o2770);
    ensureSessionJournalDir(data, mintId('cs'));
    expect(mode(path.join(data, 'journals'))).toBe(0o2770);
  });

  it('a session directory is 02770 whatever the umask, and made again it stays', () => {
    const id = mintId('cs');
    const before = process.umask(0o077);
    try {
      expect(mode(ensureSessionJournalDir(data, id))).toBe(0o2770);
    } finally {
      process.umask(before);
    }
    expect(mode(ensureSessionJournalDir(data, id))).toBe(0o2770);
  });

  it('a link where a session directory goes is refused before anything is chmodded through it', () => {
    const id = mintId('cs');
    fs.symlinkSync(target, path.join(ensureJournalDir(data), id));
    expect(() => ensureSessionJournalDir(data, id)).toThrow(/not a directory/);
    expect(mode(target)).toBe(0o700);
  });

  it('saveResult refuses a link where the results directory goes, and leaves its target as it was', () => {
    const id = mintId('cs');
    ensureSessionJournalDir(data, id);
    const journal = journalPath(data, id);
    fs.symlinkSync(target, `${journal}.results`);
    expect(() => saveResult(journal, mintId('sa'), 'x')).toThrow(/not a directory/);
    expect(mode(target)).toBe(0o700);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});
