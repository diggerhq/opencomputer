import { describe, expect, it } from 'vitest';
import { decodeAccessId, encodeAccessId } from './action-ids.js';
import { decodeActionId, encodeActionId, type TraceContext } from './protocol.js';
import fixture from './telemetry/deliver-trace.fixture.json' with { type: 'json' };

describe('action ids', () => {
  it('round-trips a thread key with colons and dots', () => {
    const id = encodeActionId('C0B:1791495325.000001', 'p1', 'allow');
    expect(id.startsWith('p:')).toBe(true);
    expect(decodeActionId(id)).toEqual({ sessionKey: 'C0B:1791495325.000001', promptId: 'p1', value: 'allow' });
  });

  it('keeps colons in the value (question answers are `qi.oi`, but values may be anything)', () => {
    expect(decodeActionId(encodeActionId('C0B', 'p', 'a:b:c'))!.value).toBe('a:b:c');
  });

  it('stays under Slack’s 255-char action_id limit for a thread key', () => {
    expect(encodeActionId('C0123456789:1791495325.000001', 'abcdef12', 'always').length).toBeLessThan(255);
  });

  it('rejects ids that are not prompt actions', () => {
    expect(decodeActionId('a:panel:stop:task')).toBeUndefined();
    expect(decodeActionId('p:not*base64:x:y')).toBeUndefined();
    expect(decodeActionId('')).toBeUndefined();
  });
});

describe('access ids (work 112)', () => {
  it('round-trip open, and allow/deny with the requester', () => {
    const key = 'C0B:1791495325.000001';
    expect(encodeAccessId(key, 'open')).toBe(`ac:${Buffer.from(key).toString('base64url')}:open`);
    expect(decodeAccessId(encodeAccessId(key, 'open'))).toEqual({ sessionKey: key, verb: 'open' });
    expect(decodeAccessId(encodeAccessId(key, 'allow', 'U0123ABC'))).toEqual({ sessionKey: key, verb: 'allow', userId: 'U0123ABC' });
    expect(decodeAccessId(encodeAccessId('T1:C2:1791495325.000001', 'deny', 'W9'))).toEqual({
      sessionKey: 'T1:C2:1791495325.000001',
      verb: 'deny',
      userId: 'W9',
    });
  });

  it('encode the key as the prompt ids do, and stay under Slack’s 255 chars', () => {
    const key = 'T0123456789:C0123456789:1791495325.000001';
    expect(encodeAccessId(key, 'allow', 'U0123456789').split(':')[1]).toBe(encodeActionId(key, 'p', 'v').split(':')[1]);
    expect(encodeAccessId(key, 'allow', 'U0123456789').length).toBeLessThan(255);
  });

  it('rejects anything else', () => {
    const k = Buffer.from('C0B').toString('base64url');
    for (const id of [
      '',
      `p:${k}:p1:allow`,
      `ac:${k}`,
      `ac:${k}:open:U1`,
      `ac:${k}:allow`,
      `ac:${k}:deny:`,
      `ac:${k}:grant:U1`,
      'ac:not*base64:open',
      'ac::open',
    ])
      expect(decodeAccessId(id), id).toBeUndefined();
    expect(decodeActionId(encodeAccessId('C0B', 'open'))).toBeUndefined();
  });
});

describe('telemetry trace context (work 054)', () => {
  it('matches the contract fixture the backend also checks', () => {
    const trace: TraceContext | undefined = (fixture as { trace?: TraceContext }).trace;
    expect(trace).toMatchObject({ id: expect.any(String), sentAt: expect.any(Number), receivedAt: expect.any(Number), surface: 'slack' });
    expect(trace!.receivedAt).toBeGreaterThanOrEqual(trace!.sentAt);
  });
});
