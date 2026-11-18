// access-store.ts against an in-memory database: drivers' default and round
// trip, held context's limits, one request per person, the org default.

import { describe, expect, it } from 'vitest';
import { CONTEXT_MAX_AGE_MS, CONTEXT_MAX_CHARS, CONTEXT_MAX_ROWS } from '../access.js';
import { AccessStore } from './access-store.js';
import { Store } from './db.js';

const spec = { key: 'C1:1.1', kind: 'thread', channel: 'C1', threadTs: '1.1', owner: { slackUserId: 'U1', dir: 'o', gitName: 'O', gitEmail: 'o@e' }, teamId: 'T1', title: 't', mode: 'default' } as const;

function fresh() {
  const store = new Store(':memory:');
  store.putSession(spec);
  return store.access;
}

describe('drivers', () => {
  it('is open for a session without a write, and for no session at all', () => {
    const a = fresh();
    expect(a.drivers(spec.key)).toBe('*');
    expect(a.drivers('nope')).toBe('*');
  });

  it('round-trips a list and `[]`', () => {
    const a = fresh();
    a.writeDrivers(spec.key, ['U2', 'U3']);
    expect(a.drivers(spec.key)).toEqual(['U2', 'U3']);
    a.writeDrivers(spec.key, []);
    expect(a.drivers(spec.key)).toEqual([]);
  });

  it('the column is added once: a second store on the same database keeps it', () => {
    const store = new Store(':memory:');
    store.putSession(spec);
    store.access.writeDrivers(spec.key, []);
    expect(new AccessStore(store.db).drivers(spec.key)).toEqual([]);
  });
});

describe('held context', () => {
  it('reads oldest first, cuts long text and keeps file names', () => {
    const a = fresh();
    a.hold(spec.key, 'U2', '2.1', 'x'.repeat(CONTEXT_MAX_CHARS + 10), ['a.png']);
    a.hold(spec.key, 'U3', '2.2', 'second');
    const rows = a.held(spec.key);
    expect(rows.map((r) => r.ts)).toEqual(['2.1', '2.2']);
    expect(rows[0].text).toHaveLength(CONTEXT_MAX_CHARS);
    expect(rows[0].files).toEqual(['a.png']);
    expect(rows[1].files).toBeUndefined();
  });

  it('keeps the newest CONTEXT_MAX_ROWS and says how many were left out', () => {
    const a = fresh();
    for (let i = 0; i < CONTEXT_MAX_ROWS + 3; i++) a.hold(spec.key, 'U2', `2.${i}`, `m${i}`);
    const rows = a.held(spec.key);
    expect(rows).toHaveLength(CONTEXT_MAX_ROWS);
    expect(rows[0]).toMatchObject({ text: 'm3', skipped: 3 });
    expect(rows[1].skipped).toBeUndefined();
  });

  it('drops rows older than CONTEXT_MAX_AGE_MS, and only this session’s', () => {
    const a = fresh();
    const now = 10 * CONTEXT_MAX_AGE_MS;
    a.hold(spec.key, 'U2', '2.1', 'old', [], now - CONTEXT_MAX_AGE_MS - 1);
    a.hold(spec.key, 'U2', '2.2', 'new', [], now);
    a.hold('other', 'U2', '2.3', 'old elsewhere', [], 0);
    expect(a.held(spec.key, now).map((r) => r.text)).toEqual(['new']);
    expect(a.held('other', 0).map((r) => r.text)).toEqual(['old elsewhere']);
  });

  it('release deletes every row up to a seq, also those left out; releaseTs by the message’s ts', () => {
    const a = fresh();
    for (let i = 1; i <= CONTEXT_MAX_ROWS + 3; i++) a.hold(spec.key, 'U2', `2.${i}`, `m${i}`);
    a.hold('other', 'U2', '2.0', 'elsewhere');
    const read = a.held(spec.key);
    a.hold(spec.key, 'U2', '2.99', 'later');
    a.hold(spec.key, 'U2', '2.100', 'gone');
    a.release(spec.key, read.at(-1)!.seq);
    a.releaseTs(spec.key, '2.100');
    expect(a.held(spec.key).map((r) => r.text)).toEqual(['later']);
    expect(a.held('other')).toHaveLength(1);
  });
});

describe('requests', () => {
  it('one per person per session: a closed one stays and is never replaced', () => {
    const a = fresh();
    expect(a.putRequest(spec.key, 'U2', '{"m":1}', 1)).toBe(true);
    a.requestPosted(spec.key, 'U2', '3.1');
    expect(a.putRequest(spec.key, 'U3', '{"m":2}', 2)).toBe(true);
    expect(a.openRequests(spec.key).map((r) => r.userId)).toEqual(['U2', 'U3']);
    a.closeRequest(spec.key, 'U2');
    expect(a.putRequest(spec.key, 'U2', '{"m":3}', 3)).toBe(false);
    expect(a.request(spec.key, 'U2')).toEqual({ key: spec.key, userId: 'U2', state: 'closed', messageTs: '3.1', held: '{"m":1}', at: 1 });
    expect(a.openRequests(spec.key).map((r) => r.userId)).toEqual(['U3']);
    expect(a.request(spec.key, 'U9')).toBeUndefined();
  });

  it('a request whose message was not posted is dropped, so the person can ask again', () => {
    const a = fresh();
    a.putRequest(spec.key, 'U2', '{"m":1}');
    a.dropRequest(spec.key, 'U2');
    expect(a.request(spec.key, 'U2')).toBeUndefined();
    expect(a.putRequest(spec.key, 'U2', '{"m":2}')).toBe(true);
  });
});

describe('accessDefault', () => {
  it('is open until set, and overwrites', () => {
    const a = fresh();
    expect(a.accessDefault()).toBe('open');
    a.setAccessDefault('owner');
    expect(a.accessDefault()).toBe('owner');
    a.setAccessDefault('open');
    expect(a.accessDefault()).toBe('open');
  });
});
