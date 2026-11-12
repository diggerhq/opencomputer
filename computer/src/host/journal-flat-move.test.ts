import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { journalPath, readJournalFile } from '../api/journal.js';
import { loadResult } from '../api/subagent-results.js';
import { mintId } from '../session-ids.js';
import { moveFlatJournals } from './journal-flat-move.js';

let data: string;
let journals: string;
beforeEach(() => {
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
});
