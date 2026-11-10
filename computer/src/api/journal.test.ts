import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiActor } from '../protocol.js';
import { mintId } from '../session-ids.js';
import { ensureJournalDir, Journal, journalPath, readJournalFile } from './journal.js';
import { EVENT_DATA, Event } from './schema-events.js';

const ann: ApiActor = { id: 'usr_ann', name: null, via: 'api', client: 'test/1' };
let dir: string;
let sid: string;
let file: string;
const open: Journal[] = [];
const take = async (o: Partial<Parameters<typeof Journal.open>[1]> = {}) => {
  const j = await Journal.open(file, { sessionId: sid, epoch: 1, lastSeq: 0, ...o });
  open.push(j);
  return j;
};
const status = (j: Journal, from: string | null, to: string) => j.append('session.status_changed', { from, to }, { actor: ann });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  sid = mintId('cs');
  file = journalPath(dir, sid);
  ensureJournalDir(dir);
});
afterEach(async () => {
  for (const j of open.splice(0)) await j.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('journalPath / ensureJournalDir', () => {
  it('puts journals under <data>/journals with a setgid, group-writable dir', () => {
    expect(file).toBe(path.join(dir, 'journals', `${sid}.jsonl`));
    expect(fs.statSync(path.join(dir, 'journals')).mode & 0o7777).toBe(0o2770);
    expect(() => journalPath(dir, '../x')).toThrow();
  });
});

describe('Journal', () => {
  it('appends events matching the Event schema, with a named actor', async () => {
    const j = await take();
    const e = status(j, null, 'idle');
    expect(e.seq).toBe(1);
    expect(e.actor?.name).toBe('usr_ann');
    Schema.decodeUnknownSync(Event)(e);
    Schema.decodeUnknownSync(EVENT_DATA['session.status_changed'])(e.data);
    expect(j.read(0)).toEqual([e]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o660);
  });

  it('is exclusive: a second open is refused while the first holds it, and allowed after release', async () => {
    const a = await take();
    await expect(Journal.open(file, { sessionId: sid, epoch: 1, lastSeq: 0 })).rejects.toMatchObject({ code: 'locked' });
    await a.release();
    open.splice(0);
    const b = await take();
    expect(b.lastSeq).toBe(0);
  });

  it('continues under the same epoch, keeping seqs', async () => {
    const a = await take();
    for (let i = 0; i < 5; i++) status(a, 'idle', 'running');
    await a.release();
    open.splice(0);
    const b = await take({ lastSeq: 3 });
    expect(b.lastSeq).toBe(5);
    expect(b.epochStartSeq).toBe(1);
    expect(status(b, 'running', 'idle').seq).toBe(6);
  });

  it('refuses a lower epoch', async () => {
    await (await take({ epoch: 3 })).release();
    open.splice(0);
    await expect(take({ epoch: 2 })).rejects.toMatchObject({ code: 'stale_epoch' });
  });

  it('a higher epoch truncates past the DO\'s lastSeq and starts a new epoch', async () => {
    const a = await take();
    for (let i = 0; i < 6; i++) status(a, 'idle', 'running');
    await a.release();
    open.splice(0);
    const b = await take({ epoch: 2, lastSeq: 4 });
    expect(b.lastSeq).toBe(4);
    expect(b.epochStartSeq).toBe(5);
    expect(b.read(0).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const e = status(b, 'idle', 'suspended');
    expect(e.seq).toBe(5);
    expect(readJournalFile(file, 0).events.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(readJournalFile(file, 0).epoch).toBe(2);
  });

  it('a higher epoch with the DO ahead continues from the DO\'s lastSeq', async () => {
    const a = await take();
    status(a, null, 'idle');
    await a.release();
    open.splice(0);
    const b = await take({ epoch: 2, lastSeq: 9 });
    expect(b.lastSeq).toBe(9);
    expect(status(b, 'idle', 'running').seq).toBe(10);
  });

  it('pages reads through the sparse index', async () => {
    const j = await take();
    for (let i = 0; i < 300; i++) status(j, 'idle', 'running');
    expect(j.read(0, 1000)).toHaveLength(300);
    expect(j.read(130, 5).map((e) => e.seq)).toEqual([131, 132, 133, 134, 135]);
    expect(j.read(299, 10).map((e) => e.seq)).toEqual([300]);
    expect(j.read(300)).toEqual([]);
  });

  it('indexes turns for tailTurns', async () => {
    const j = await take();
    status(j, null, 'idle');
    const turns = [mintId('tn'), mintId('tn'), mintId('tn')];
    for (const t of turns) {
      j.append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId: t, actor: ann });
      j.append('turn.completed', { text: 'ok', durationMs: 1, silent: false }, { turnId: t, actor: ann });
    }
    expect(j.turns().map((t) => t.turnId)).toEqual(turns);
    expect(j.tailTurnsAfter(2)).toBe(3);
    expect(j.readTailTurns(1).map((e) => e.turnId)).toEqual([turns[2], turns[2]]);
    expect(j.tailTurnsAfter(10)).toBe(1);
  });

  it('keeps idempotency records across reopen, for 24 h', async () => {
    let now = 1_000_000;
    const a = await take({ now: () => now });
    a.idemPut({ id: 'k1', op: 'turns.send', hash: 'h', result: { x: 1 }, seq: 0 });
    await a.release();
    open.splice(0);
    const b = await take({ now: () => now });
    expect(b.idemGet('k1')).toMatchObject({ hash: 'h', result: { x: 1 } });
    now += 24 * 3600_000;
    expect(b.idemGet('k1')).toBeUndefined();
  });

  it('redacts every string in data', async () => {
    const j = await take({ redact: (s) => s.replaceAll('sekrit', '[redacted]') });
    const e = j.append('message.received', { input: 'my sekrit', ifBusy: 'queue', delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] }, { turnId: mintId('tn'), actor: ann });
    expect((e.data as { input: string }).input).toBe('my [redacted]');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sekrit');
  });

  it('drops a torn last line on open', async () => {
    const a = await take();
    status(a, null, 'idle');
    await a.release();
    open.splice(0);
    fs.appendFileSync(file, '{"seq":2,"type":"x"');
    const b = await take();
    expect(b.lastSeq).toBe(1);
    expect(status(b, 'idle', 'running').seq).toBe(2);
    expect(readJournalFile(file, 0).events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('acks are kept in memory, never past lastSeq or for another epoch', async () => {
    const j = await take();
    status(j, null, 'idle');
    status(j, 'idle', 'running');
    j.ack(1, 1);
    j.ack(2, 2);
    j.ack(1, 99);
    expect(j.acked).toBe(2);
    expect(j.unackedAfter()).toEqual([]);
  });

  it('budget: append p99 < 1 ms over 10k appends', async () => {
    const j = await take();
    const tid = mintId('tn');
    const data = { toolName: 'Bash', callId: 'c1', parentCallId: null, title: 'ls', input: { command: 'ls -la /tmp' }, inputTruncated: false };
    const times: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t0 = process.hrtime.bigint();
      j.append('tool.started', data, { turnId: tid, actor: ann });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    const p99 = times[Math.floor(times.length * 0.99)];
    console.log(`journal.append p50 ${times[5000].toFixed(4)} ms, p99 ${p99.toFixed(4)} ms, max ${times[times.length - 1].toFixed(3)} ms`);
    expect(p99).toBeLessThan(1);
    expect(j.lastSeq).toBe(10_000);
  });

  it('an epoch frame: truncates at its first seq, appends the DO tail verbatim, continues at lastSeq + 1 (recovery-fix)', async () => {
    const a = await take();
    for (let i = 0; i < 6; i++) status(a, null, `s${i}`);
    await a.release();
    open.splice(0);
    const tail = [4, 5].map((seq) => ({
      id: `ev_do${seq}`,
      seq,
      createdAt: '2026-10-26T00:00:00.000Z',
      sessionId: sid,
      turnId: null,
      type: 'runtime.suspended',
      actor: null,
      data: { reason: 'lost' },
    }));
    const b = await take({ epoch: 2, lastSeq: 5, epochStartSeq: 4, tail });
    expect(b.epochStartSeq).toBe(4);
    expect(b.lastSeq).toBe(5);
    const r = readJournalFile(file, 0);
    expect(r.epoch).toBe(2);
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.events.slice(3)).toEqual(tail);
    expect(status(b, null, 'next').seq).toBe(6);
    expect(b.read(3)).toEqual([...tail, expect.objectContaining({ seq: 6 })]);
  });

  it('an adoption that dies mid-tail leaves the file at its old epoch; the rerun adopts it identically (review r2 P1-2)', async () => {
    const a = await take();
    for (let i = 0; i < 6; i++) status(a, null, `s${i}`);
    await a.release();
    open.splice(0);
    const ev = (seq: number, data: unknown) => ({ id: `ev_do${seq}`, seq, createdAt: '', sessionId: sid, turnId: null, type: 'runtime.suspended', actor: null, data });
    // The write of seq 5 throws (a crash, a full disk) after seq 4 is on file.
    const torn = [ev(4, { reason: 'lost' }), ev(5, { bad: 1n }), ev(6, {})] as never[];
    await expect(Journal.open(file, { sessionId: sid, epoch: 2, lastSeq: 6, epochStartSeq: 4, tail: torn })).rejects.toThrow();
    const r = readJournalFile(file, 0);
    expect(r).toMatchObject({ epoch: 1, startSeq: 1, lastSeq: 4 });
    expect(r.events.map((e) => e.id)).toEqual([expect.stringMatching(/^ev_/), expect.anything(), expect.anything(), 'ev_do4']);
    // The gateway's next `epoch` (hello says 1): cut at 4 again, the whole tail, then the commit record.
    const tail = [ev(4, { reason: 'lost' }), ev(5, {}), ev(6, {})];
    const b = await take({ epoch: 2, lastSeq: 6, epochStartSeq: 4, tail });
    expect(b.lastSeq).toBe(6);
    const r2 = readJournalFile(file, 0);
    expect(r2).toMatchObject({ epoch: 2, startSeq: 4, through: 6, lastSeq: 6 });
    expect(r2.events.slice(3)).toEqual(tail);
    // The epoch line is the last line: the commit record.
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ k: 'epoch', epoch: 2, startSeq: 4, through: 6 });
  });

  it('a file whose epoch line is ahead of its events takes the missing ones from the DO at the same epoch, nothing else', async () => {
    const a = await take();
    for (let i = 0; i < 3; i++) status(a, null, `s${i}`);
    await a.release();
    open.splice(0);
    // An adoption torn by a build that wrote the epoch line first (no `through`): epoch 2 from 4, no event of it.
    fs.appendFileSync(file, `${JSON.stringify({ k: 'epoch', sessionId: sid, epoch: 2, startSeq: 4, at: 0 })}\n`);
    expect(readJournalFile(file, 0)).toMatchObject({ epoch: 2, startSeq: 4, through: 0, lastSeq: 3 });
    const tail = [4, 5].map((seq) => ({ id: `ev_do${seq}`, seq, createdAt: '', sessionId: sid, turnId: null, type: 'x', actor: null, data: {} }));
    const b = await take({ epoch: 2, lastSeq: 5, epochStartSeq: 4, tail });
    expect(b.lastSeq).toBe(5);
    expect(readJournalFile(file, 0).events.slice(3)).toEqual(tail);
    expect(status(b, null, 'next').seq).toBe(6);
  });

  it('readJournalFile reads only what was appended since, and rescans a file cut and rewritten', async () => {
    const a = await take();
    for (let i = 0; i < 300; i++) status(a, null, `s${i}`);
    expect(readJournalFile(file, 0, 1000).events).toHaveLength(300);
    expect(readJournalFile(file, 250, 10).events.map((e) => e.seq)).toEqual([251, 252, 253, 254, 255, 256, 257, 258, 259, 260]);
    status(a, null, 'more');
    expect(readJournalFile(file, 299).events.map((e) => e.seq)).toEqual([300, 301]);
    await a.release();
    open.splice(0);
    // A new epoch cuts at 200 and writes past the old end: the cached state must not survive it.
    const tail = Array.from({ length: 150 }, (_, i) => ({
      id: `ev_new${i}`,
      seq: 200 + i,
      createdAt: '',
      sessionId: sid,
      turnId: null,
      type: 'x',
      actor: null,
      data: { pad: 'y'.repeat(40) },
    }));
    await take({ epoch: 2, lastSeq: 349, epochStartSeq: 200, tail });
    const r = readJournalFile(file, 198, 3);
    expect(r.epoch).toBe(2);
    expect(r.lastSeq).toBe(349);
    expect(r.events.map((e) => e.id)).toEqual([expect.stringMatching(/^ev_/), 'ev_new0', 'ev_new1']);
  });
});
