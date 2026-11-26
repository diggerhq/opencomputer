import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JournalEvent } from '../protocol.js';
import { checkpointPath } from './journal-checkpoint.js';
import { forgetJournalFile, Journal, readJournalFile } from './journal.js';
import type { SessionLog } from './session-log.js';
import { ANN, askOf, openLog, tempSession, turn } from './testing.js';

let t: ReturnType<typeof tempSession>;
beforeEach(() => {
  t = tempSession();
});
afterEach(() => t.cleanup());

const pad = 'x'.repeat(4000);
/** Turns until the journal is past `bytes`, and one open ask. */
function fill(log: SessionLog, bytes: number) {
  while (log.journal.size < bytes) turn(log, `q ${log.lastSeq}`, `a ${pad}`);
  log.append('ask.opened', { ask: askOf(t.sessionId, 'tn_none') }, { turnId: null, actor: ANN });
  log.journal.idemPut({ id: 'k1', op: 'turns.send', hash: 'h', result: { ok: 1 }, seq: log.lastSeq });
}

/** What a reader sees of a log: the session, every turn and ask, the turn index, a page of events. */
const view = (log: SessionLog) => ({
  session: { ...log.fold.session(), lastActiveAt: null },
  turns: log.fold.turns(),
  asks: log.fold.asks(),
  index: log.journal.turns(),
  page: log.journal.read(10, 5),
  tail: log.journal.readTailTurns(2),
  idem: log.journal.idemGet('k1')?.result,
  lastSeq: log.lastSeq,
});

/** Events the open handed to the fold (counted through a bare Journal with a fold that takes the checkpoint). */
async function appliedOnOpen(o: { epoch?: number; lastSeq?: number; epochStartSeq?: number; tail?: JournalEvent[] } = {}) {
  let n = 0;
  let restored = false;
  const j = await Journal.open(t.file, {
    sessionId: t.sessionId,
    epoch: o.epoch ?? 1,
    lastSeq: o.lastSeq ?? 0,
    epochStartSeq: o.epochStartSeq,
    tail: o.tail,
    fold: { restore: () => (restored = true), apply: () => void n++ },
  });
  await j.release();
  return { n, restored };
}

describe('journal checkpoint (084 perf fix 1)', () => {
  it('is written past 1 MiB and at release; a reopen restores the fold and reads only what follows it', async () => {
    const a = await openLog(t.file, t.sessionId);
    fill(a, 1.5 * (1 << 20));
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(checkpointPath(t.file))).toBe(true);
    turn(a, 'after', 'the checkpoint');
    const before = view(a);
    a.checkpoint();
    turn(a, 'past', 'it');
    const last = a.lastSeq;
    await a.release();
    // The release did not rewrite it (only a few hundred bytes since): the open reads those four events.
    expect(await appliedOnOpen()).toEqual({ n: 4, restored: true });
    const b = await openLog(t.file, t.sessionId);
    const v = view(b);
    expect(v.lastSeq).toBe(last);
    expect(v.turns.slice(0, -1)).toEqual(before.turns);
    await b.release();
    // The same as a fold of the whole file.
    fs.rmSync(checkpointPath(t.file));
    const c = await openLog(t.file, t.sessionId);
    expect(view(c)).toEqual(v);
    expect(v.idem).toEqual({ ok: 1 });
    expect(v.asks).toHaveLength(1);
    await c.release();
  });

  it('is ignored when the journal no longer matches it, or it is torn', async () => {
    const a = await openLog(t.file, t.sessionId);
    fill(a, 1.2 * (1 << 20));
    a.checkpoint();
    const total = a.lastSeq;
    await a.release();
    const ck = fs.readFileSync(checkpointPath(t.file));
    // Torn (a crash mid-write of an older build, a full disk): read whole.
    fs.writeFileSync(checkpointPath(t.file), ck.subarray(0, ck.length - 10));
    expect(await appliedOnOpen()).toEqual({ n: total, restored: false });
    // The journal cut below it behind our back (a lost tail): read whole.
    fs.writeFileSync(checkpointPath(t.file), ck);
    const size = fs.statSync(t.file).size;
    fs.truncateSync(t.file, size - 200);
    const r = await appliedOnOpen();
    expect(r.restored).toBe(false);
    expect(r.n).toBe(total - 1); // the torn idem line and the ask's event are gone
  });

  it('a new epoch cutting below it removes it and folds the file whole; one cutting past it keeps it', async () => {
    const a = await openLog(t.file, t.sessionId);
    fill(a, 1.2 * (1 << 20));
    a.checkpoint();
    const at = a.lastSeq;
    turn(a);
    await a.release();
    // Epoch 2 from `at` + 1: the cut is past the checkpoint, which stays and is used.
    const ev = (seq: number): JournalEvent => ({ id: `ev_do${seq}`, seq, createdAt: '', sessionId: t.sessionId, turnId: null, type: 'runtime.suspended', actor: null, data: { reason: 'lost' } });
    expect(await appliedOnOpen({ epoch: 2, lastSeq: at + 1, epochStartSeq: at + 1, tail: [ev(at + 1)] })).toEqual({ n: 1, restored: true });
    expect(fs.existsSync(checkpointPath(t.file))).toBe(true);
    // Epoch 3 from `at` - 1: the checkpoint holds events the cut drops.
    const r = await appliedOnOpen({ epoch: 3, lastSeq: at - 1, epochStartSeq: at - 1, tail: [ev(at - 1)] });
    expect(r.restored).toBe(false);
    expect(r.n).toBe(at - 1);
    expect(fs.existsSync(checkpointPath(t.file))).toBe(false);
    forgetJournalFile(t.file);
    const f = readJournalFile(t.file, at - 3);
    expect(f).toMatchObject({ epoch: 3, startSeq: at - 1, lastSeq: at - 1 });
    expect(f.events.map((e) => e.id)).toEqual([expect.stringMatching(/^ev_/), 'ev_do' + (at - 1)]);
  });

  it('readJournalFile starts its first scan at the checkpoint and answers as a full scan does', async () => {
    const a = await openLog(t.file, t.sessionId);
    fill(a, 1.2 * (1 << 20));
    a.checkpoint();
    turn(a);
    await a.release();
    forgetJournalFile(t.file);
    const fromCk = readJournalFile(t.file, 100, 50);
    const head = (r: typeof fromCk) => ({ ...r, events: r.events.map((e) => e.seq) });
    const ck = fs.readFileSync(checkpointPath(t.file), 'utf8');
    fs.rmSync(checkpointPath(t.file));
    forgetJournalFile(t.file);
    expect(head(fromCk)).toEqual(head(readJournalFile(t.file, 100, 50)));
    expect(fromCk.events).toHaveLength(50);
    // It did start there: a header it trusts (only the journal's last line is hashed) shows through.
    fs.writeFileSync(checkpointPath(t.file), ck.replace('"epoch":1,', '"epoch":7,'));
    forgetJournalFile(t.file);
    expect(readJournalFile(t.file, 0, 0).epoch).toBe(7);
  });

  it('a session too small for one has none', async () => {
    const a = await openLog(t.file, t.sessionId);
    turn(a);
    await a.release();
    expect(fs.existsSync(checkpointPath(t.file))).toBe(false);
  });
});
