import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { journalPath, readJournalFile } from '../api/journal.js';
import { loadResult } from '../api/subagent-results.js';
import { openLog, turn } from '../api/testing.js';
import { mintId } from '../session-ids.js';
import { moveFlatJournals, moveFlatSession } from './journal-flat-move.js';

// A directory another uid owns (the host is sp-host, the runner agent): chmod fails with EPERM while `uids.other` is set.
const uids = vi.hoisted(() => ({ other: false }));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  const eperm =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      if (uids.other) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      fn(...a);
    };
  const patched = { ...real, chmodSync: eperm(real.chmodSync), fchmodSync: eperm(real.fchmodSync) };
  return { ...patched, default: patched };
});

let data: string;
let journals: string;
beforeEach(() => {
  uids.other = false;
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'flatmove-'));
  journals = path.join(data, 'journals');
  fs.mkdirSync(journals);
});
afterEach(() => fs.rmSync(data, { recursive: true, force: true }));

const text = (sessionId: string, epoch: number, events: number) =>
  `${JSON.stringify({ k: 'epoch', sessionId, epoch, startSeq: 1, through: 0, at: 0 })}\n` +
  Array.from({ length: events }, (_, i) => `${JSON.stringify({ id: `ev_${i + 1}`, seq: i + 1, createdAt: '', sessionId, turnId: null, type: 'x', actor: null, data: {} })}\n`).join('');

/** A session in the layout before work 103: journal, checkpoint and one result, all directly in journals/. */
function flat(epoch = 1, events = 3) {
  const id = mintId('cs');
  const sa = mintId('sa');
  const file = path.join(journals, `${id}.jsonl`);
  fs.writeFileSync(file, text(id, epoch, events));
  fs.writeFileSync(`${file}.ckpt`, 'ckpt');
  fs.mkdirSync(`${file}.results`);
  fs.writeFileSync(path.join(`${file}.results`, sa), 'whole result');
  return { id, sa, file, nested: journalPath(data, id) };
}

const tree = () => (fs.readdirSync(journals, { recursive: true }) as string[]).sort();

describe('moveFlatJournals (work 103 C8)', () => {
  it('moves a flat journal, its checkpoint and its results into the session\'s directory, and reads the same', () => {
    const s = flat();
    const ino = fs.statSync(s.file).ino;
    expect(moveFlatJournals(data)).toBe(3);
    expect(tree()).toEqual([s.id, `${s.id}/${s.id}.jsonl`, `${s.id}/${s.id}.jsonl.ckpt`, `${s.id}/${s.id}.jsonl.results`, `${s.id}/${s.id}.jsonl.results/${s.sa}`]);
    expect(fs.statSync(s.nested).ino).toBe(ino); // a rename: a writer holding the file open keeps writing it
    expect(fs.statSync(path.dirname(s.nested)).mode & 0o7777).toBe(0o2770);
    expect(readJournalFile(s.nested, 0)).toMatchObject({ epoch: 1, lastSeq: 3 });
    expect(loadResult(s.nested, s.sa)).toBe('whole result');
  });

  it('is idempotent: a second run moves nothing and changes nothing', () => {
    const a = flat();
    flat();
    expect(moveFlatJournals(data)).toBe(6);
    const before = tree();
    const content = fs.readFileSync(a.nested, 'utf8');
    expect(moveFlatJournals(data)).toBe(0);
    expect(tree()).toEqual(before);
    expect(fs.readFileSync(a.nested, 'utf8')).toBe(content);
  });

  it('does nothing without a journals directory, and leaves what is not a journal', () => {
    expect(moveFlatJournals(path.join(data, 'none'))).toBe(0);
    fs.writeFileSync(path.join(journals, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(journals, 'not-an-id.jsonl'), 'x');
    expect(moveFlatJournals(data)).toBe(0);
    expect(tree()).toEqual(['not-an-id.jsonl', 'notes.txt']);
  });

  it('finishes a move that was interrupted at any point', () => {
    // Each prefix of the three renames, then the rerun.
    for (const done of [['.results'], ['.ckpt'], [''], ['', '.ckpt'], ['.results', '.ckpt']]) {
      const s = flat();
      fs.mkdirSync(path.dirname(s.nested));
      for (const part of done) fs.renameSync(s.file + part, s.nested + part);
      expect(moveFlatJournals(data)).toBe(3 - done.length);
      expect(fs.readdirSync(journals).filter((n) => n.startsWith(`${s.id}.`))).toEqual([]);
      expect(readJournalFile(s.nested, 0).lastSeq).toBe(3);
      expect(fs.readFileSync(`${s.nested}.ckpt`, 'utf8')).toBe('ckpt');
      expect(loadResult(s.nested, s.sa)).toBe('whole result');
    }
  });

  it('a runner from before the move wrote flat again: its checkpoint and results join the nested ones', () => {
    const s = flat();
    moveFlatJournals(data);
    const sa2 = mintId('sa');
    fs.writeFileSync(`${s.file}.ckpt`, 'newer');
    fs.writeFileSync(`${s.file}.ckpt.tmp`, 'torn');
    fs.mkdirSync(`${s.file}.results`);
    fs.writeFileSync(path.join(`${s.file}.results`, sa2), 'second');
    expect(moveFlatJournals(data)).toBe(2);
    expect(fs.readdirSync(journals)).toEqual([s.id]);
    expect(fs.readFileSync(`${s.nested}.ckpt`, 'utf8')).toBe('newer');
    expect(loadResult(s.nested, s.sa)).toBe('whole result');
    expect(loadResult(s.nested, sa2)).toBe('second');
  });

  it('with both a flat and a nested journal, the one further on is the journal and the other is kept aside', () => {
    const behind = flat(1, 2);
    fs.mkdirSync(path.dirname(behind.nested));
    fs.writeFileSync(behind.nested, text(behind.id, 2, 5));
    const ahead = flat(3, 1);
    fs.mkdirSync(path.dirname(ahead.nested));
    fs.writeFileSync(ahead.nested, text(ahead.id, 2, 5));
    moveFlatJournals(data);
    expect(fs.readFileSync(behind.nested, 'utf8')).toBe(text(behind.id, 2, 5));
    expect(fs.readFileSync(`${behind.nested}.superseded`, 'utf8')).toBe(text(behind.id, 1, 2));
    expect(fs.readFileSync(ahead.nested, 'utf8')).toBe(text(ahead.id, 3, 1));
    expect(fs.readFileSync(`${ahead.nested}.superseded`, 'utf8')).toBe(text(ahead.id, 2, 5));
    expect(readJournalFile(ahead.nested, 0)).toMatchObject({ epoch: 3, lastSeq: 1 });
    expect(fs.readdirSync(journals).sort()).toEqual([behind.id, ahead.id].sort());
  });

  it('never follows a link: a flat name that is one stays where it is, and the others still move', () => {
    const id = mintId('cs');
    const secret = path.join(data, 'secret');
    fs.writeFileSync(secret, text(id, 1, 1));
    fs.symlinkSync(secret, path.join(journals, `${id}.jsonl`));
    fs.symlinkSync(data, path.join(journals, `${id}.jsonl.results`));
    const s = flat();
    expect(moveFlatJournals(data)).toBe(3);
    expect(fs.lstatSync(path.join(journals, `${id}.jsonl`)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(journals, id))).toBe(false);
    expect(fs.existsSync(secret)).toBe(true);
    expect(readJournalFile(s.nested, 0).lastSeq).toBe(3);
  });

  it('a second journal set aside does not replace the first (a release rolled back and forward twice)', () => {
    const s = flat(1, 2);
    fs.mkdirSync(path.dirname(s.nested));
    fs.writeFileSync(s.nested, text(s.id, 2, 5));
    moveFlatSession(data, s.id);
    fs.writeFileSync(s.file, text(s.id, 2, 4));
    moveFlatSession(data, s.id);
    fs.writeFileSync(s.file, text(s.id, 3, 1));
    moveFlatSession(data, s.id);
    expect(fs.readFileSync(s.nested, 'utf8')).toBe(text(s.id, 3, 1));
    const asides = fs.readdirSync(path.dirname(s.nested)).filter((n) => n.includes('.superseded'));
    expect(asides.map((n) => fs.readFileSync(path.join(path.dirname(s.nested), n), 'utf8')).sort()).toEqual([text(s.id, 1, 2), text(s.id, 2, 4), text(s.id, 2, 5)].sort());
  });

  describe('a nested .results the session planted (it can write its own directory)', () => {
    /** A flat session whose nested directory already has `.results` as a link to a directory only the host may write. */
    const planted = () => {
      const s = flat();
      const hostOnly = path.join(data, 'host-only');
      fs.mkdirSync(hostOnly, { mode: 0o700 });
      fs.mkdirSync(path.dirname(s.nested));
      fs.symlinkSync(hostOnly, `${s.nested}.results`);
      return { ...s, hostOnly };
    };

    it('is not written through: the flat results stay where they are, the rest moves', () => {
      const s = planted();
      expect(moveFlatJournals(data)).toBe(2);
      expect(fs.readdirSync(s.hostOnly)).toEqual([]);
      expect(fs.readFileSync(path.join(`${s.file}.results`, s.sa), 'utf8')).toBe('whole result');
      expect(fs.lstatSync(`${s.nested}.results`).isSymbolicLink()).toBe(true);
      expect(readJournalFile(s.nested, 0).lastSeq).toBe(3);
    });

    it('is not chmodded, and gets no link from the flat name, when a runner still writes', async () => {
      const s = planted();
      fs.rmSync(`${s.file}.results`, { recursive: true });
      const runner = await openLog(s.file, s.id);
      expect(moveFlatJournals(data)).toBe(2);
      expect(fs.statSync(s.hostOnly).mode & 0o7777).toBe(0o700);
      expect(fs.existsSync(`${s.file}.results`)).toBe(false);
      await runner.release();
    });
  });

  it('moves only regular files named as a subagent into existing nested results; a torn write goes, the rest stays flat', () => {
    const s = flat();
    moveFlatJournals(data);
    const sa2 = mintId('sa');
    const dir = `${s.file}.results`;
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, sa2), 'second');
    fs.writeFileSync(path.join(dir, `${mintId('sa')}.tmp`), 'torn');
    fs.writeFileSync(path.join(dir, 'other'), 'x');
    fs.symlinkSync(path.join(data, 'secret'), path.join(dir, mintId('sa')));
    moveFlatJournals(data);
    expect(loadResult(s.nested, sa2)).toBe('second');
    expect(fs.readdirSync(`${s.nested}.results`).sort()).toEqual([s.sa, sa2].sort());
    expect(fs.readdirSync(dir).length).toBe(2); // the link and the unknown name
    fs.rmSync(dir, { recursive: true });
  });

  describe('a runner that outlived the host (the previous release: it writes beside the flat name it was given)', () => {
    /** saveResult as the release before work 103 wrote it: no link check, the directory made on the way. */
    const oldSaveResult = (journal: string, sa: string, body: string) => {
      const dir = `${journal}.results`;
      fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
      fs.writeFileSync(path.join(dir, `${sa}.tmp`), body);
      fs.renameSync(path.join(dir, `${sa}.tmp`), path.join(dir, sa));
    };

    it('what it writes after the move reaches the host: results at once, its checkpoint when the session is next opened', async () => {
      const id = mintId('cs');
      const file = path.join(journals, `${id}.jsonl`);
      const nested = journalPath(data, id);
      const [sa1, sa2] = [mintId('sa'), mintId('sa')];
      const runner = await openLog(file, id); // holds the journal open, and its lock, across the host's restart
      turn(runner);
      runner.checkpoint();
      oldSaveResult(file, sa1, 'before');

      expect(moveFlatJournals(data)).toBe(3); // the new host starts
      expect(fs.readdirSync(journals).sort()).toEqual([id, `${id}.jsonl.results`]);
      expect(fs.readlinkSync(`${file}.results`)).toBe(path.join(id, `${id}.jsonl.results`));
      const early = fs.readFileSync(`${nested}.ckpt`);

      turn(runner);
      runner.checkpoint();
      oldSaveResult(file, sa2, 'after');
      const lastSeq = runner.journal.lastSeq;

      // The host, reading only the nested layout: the events, both results, and a checkpoint that is older but right.
      expect(readJournalFile(nested, 0)).toMatchObject({ lastSeq });
      expect(loadResult(nested, sa1)).toBe('before');
      expect(loadResult(nested, sa2)).toBe('after');
      expect(fs.readFileSync(`${nested}.ckpt`)).toEqual(early);
      // Another host restart under the same runner changes nothing but takes the checkpoint so far.
      const second = fs.readFileSync(`${file}.ckpt`);
      expect(moveFlatJournals(data)).toBe(1);
      expect(fs.readFileSync(`${nested}.ckpt`)).toEqual(second);
      expect(fs.lstatSync(`${file}.results`).isSymbolicLink()).toBe(true);

      turn(runner);
      runner.checkpoint(); // its last, flat
      await runner.release(); // the lock goes with it
      const last = fs.readFileSync(`${file}.ckpt`);
      expect(last).not.toEqual(second);
      expect(moveFlatSession(data, id)).toBe(1); // the host, before it opens the session
      expect(fs.readdirSync(journals)).toEqual([id]); // the link went with the runner
      expect(fs.readFileSync(`${nested}.ckpt`)).toEqual(last);
      const next = await openLog(nested, id);
      expect(next.journal.lastSeq).toBe(runner.journal.lastSeq);
      expect(loadResult(nested, sa2)).toBe('after');
      await next.release();
      expect(moveFlatSession(data, id)).toBe(0);
    });

    it('gets its link where the nested results are another uid\'s (the chmod is refused)', async () => {
      const id = mintId('cs');
      const file = path.join(journals, `${id}.jsonl`);
      const runner = await openLog(file, id);
      fs.mkdirSync(path.join(journals, id));
      fs.mkdirSync(`${journalPath(data, id)}.results`); // made by the runner's uid
      uids.other = true;
      expect(moveFlatSession(data, id)).toBe(1);
      uids.other = false;
      expect(fs.readlinkSync(`${file}.results`)).toBe(path.join(id, `${id}.jsonl.results`));
      await runner.release();
    });

    it('is not looked for behind a journal nobody wrote for a day: host start runs no lock probe per old journal', async () => {
      const id = mintId('cs');
      const file = path.join(journals, `${id}.jsonl`);
      const holder = await openLog(file, id); // the lock is held, so a probe would say a writer lives and leave a link
      const old = Date.now() / 1000 - 2 * 86400;
      fs.utimesSync(file, old, old);
      expect(moveFlatJournals(data)).toBe(1);
      expect(fs.readdirSync(journals)).toEqual([id]);
      await holder.release();
    });

    it('a nested checkpoint newer than the flat one is kept, and no link is left for a session nobody writes', async () => {
      const s = flat();
      moveFlatJournals(data);
      expect(fs.readdirSync(journals)).toEqual([s.id]); // no writer: no link
      fs.writeFileSync(`${s.file}.ckpt`, 'older');
      fs.utimesSync(`${s.file}.ckpt`, 1, 1);
      expect(moveFlatSession(data, s.id)).toBe(1);
      expect(fs.readFileSync(`${s.nested}.ckpt`, 'utf8')).toBe('ckpt');
      expect(fs.readdirSync(journals)).toEqual([s.id]);
    });
  });
});
