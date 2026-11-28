import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type JobRow, openLedger, readLedger } from './ledger.js';

const fence = { org: 'o', sessionKey: 's', runnerId: 'r', epoch: 1 };
const row = (id: string, patch: Partial<JobRow> = {}): JobRow => ({ id, fence, state: 'submitted', size: 's', cmd: 'make', artifacts: [], minutes: 10, sourceBytes: 1, createdAt: 0, ...patch });

describe('ledger', () => {
  it('last row per id wins, survives reopening, compacts, skips torn lines', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    const l = openLedger(dir, 0);
    l.put(row('a'));
    l.put(row('a', { state: 'running' }), true);
    l.put(row('old', { state: 'done', endedAt: 0 }));
    l.close();
    appendFileSync(path.join(dir, 'jobs.jsonl'), '{"id":"torn');
    expect(readLedger(dir).rows.get('a')?.state).toBe('running');
    const again = openLedger(dir, 8 * 24 * 3600_000);
    expect(again.skipped).toBe(1);
    expect(again.all().map((r) => r.id)).toEqual(['a']);
    expect(readFileSync(path.join(dir, 'jobs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    again.close();
  });
});
