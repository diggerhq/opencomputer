import { describe, expect, it } from 'vitest';
import { decodeActionId, encodeActionId, type GatewayToHost, type TraceContext } from './protocol.js';
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

describe('telemetry trace context (work 054)', () => {
  it('matches the contract fixture the backend also checks', () => {
    const m = fixture as GatewayToHost;
    if (m.t !== 'deliver') throw new Error('fixture is not a deliver');
    const trace: TraceContext | undefined = m.trace;
    expect(trace).toMatchObject({ id: expect.any(String), sentAt: expect.any(Number), receivedAt: expect.any(Number), surface: 'slack' });
    expect(trace!.receivedAt).toBeGreaterThanOrEqual(trace!.sentAt);
  });
});
