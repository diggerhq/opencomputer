import { describe, expect, it } from 'vitest';
import { mintId } from '../session-ids.js';
import { checkCliForward, checkCliFrame, CLI_LIMITS } from './cli-telemetry.js';

const NOW = Date.UTC(2026, 9, 26);
const mine = mintId('cs');
const theirs = mintId('cs');
const ctx = { member: 'usr_me', maySee: (s: string) => s === mine, now: () => NOW };
const client = { name: 'opc', version: '0.1.0-rc.4', os: 'darwin', arch: 'arm64' };
const frame = (...events: unknown[]) => ({ v: 1, client, events });
const turn = { name: 'cli.turn', at: NOW - 1000, sessionId: mine, turnId: 'tn_1', data: { first_event_ms: 640, first_output_ms: 812.6 } };

describe('checkCliFrame', () => {
  it('passes a good event with the connection member, the header and the client time', () => {
    const r = checkCliFrame(frame(turn), 300, ctx);
    expect(r.rejected).toBe(0);
    expect(r.events).toEqual([
      {
        name: 'cli.turn',
        fields: { first_event_ms: 640, first_output_ms: 813, client_version: '0.1.0-rc.4', os: 'darwin', arch: 'arm64', person_id: 'usr_me', session_key: mine, turn_id: 'tn_1', at: NOW - 1000 },
      },
    ]);
  });

  it('never takes a person from the client, and folds an unknown os into other', () => {
    const r = checkCliFrame({ v: 1, client: { ...client, os: 'plan9' }, events: [{ ...turn, person_id: 'usr_else' }] }, 300, ctx);
    expect(r.events[0].fields.person_id).toBe('usr_me');
    expect(r.events[0].fields.os).toBe('other');
  });

  it('uses the relay clock for a time more than a day off', () => {
    expect(checkCliFrame(frame({ ...turn, at: NOW - 2 * CLI_LIMITS.skewMs }), 300, ctx).events[0].fields.at).toBe(NOW);
  });

  it('drops events with content, paths, unknown keys or sessions the connection may not see (forbidden shapes)', () => {
    const bad = [
      { ...turn, sessionId: theirs },
      { ...turn, sessionId: 'not-a-session' },
      { ...turn, turnId: 'a b' },
      { ...turn, data: { first_event_ms: 1, prompt: 'what is in /etc/passwd' } },
      { ...turn, data: { first_event_ms: '1' } },
      { ...turn, data: { first_event_ms: -5 } },
      { name: 'cli.control', data: { kind: 'rm -rf' } },
      { name: 'cli.error', data: { class: 'TypeError: x is undefined at /Users/me/app.js' } },
      { name: 'cli.secret', data: {} },
      { name: 'cli.turn', data: null },
      null,
    ];
    const r = checkCliFrame(frame(turn, ...bad), 2000, ctx);
    expect(r.events).toHaveLength(1);
    expect(r.rejected).toBe(bad.length);
    expect(JSON.stringify(r.events)).not.toMatch(/passwd|rm -rf|Users/);
  });

  it('drops a bad frame whole', () => {
    expect(checkCliFrame({ ...frame(turn), v: 2 }, 300, ctx)).toEqual({ events: [], rejected: 1 });
    expect(checkCliFrame({ v: 1, client: { ...client, name: 'curl' }, events: [turn] }, 300, ctx).events).toEqual([]);
    expect(checkCliFrame(frame(turn), CLI_LIMITS.frameBytes + 1, ctx).events).toEqual([]);
    expect(checkCliFrame(frame(...Array(CLI_LIMITS.events + 1).fill(turn)), 300, ctx)).toEqual({ events: [], rejected: CLI_LIMITS.events + 1 });
    expect(checkCliFrame(frame(), 300, ctx).events).toEqual([]);
  });
});

describe('checkCliForward (the host check)', () => {
  it('accepts what the relay forwards', () => {
    const [e] = checkCliFrame(frame(turn), 300, ctx).events;
    expect(checkCliForward(e.name, e.fields)).toMatchObject({ name: 'cli.turn', at: NOW - 1000, person_id: 'usr_me', session_key: mine, data: { first_event_ms: 640, os: 'darwin' } });
  });

  it('refuses anything off', () => {
    const [e] = checkCliFrame(frame(turn), 300, ctx).events;
    expect(checkCliForward('cli.nope', e.fields)).toBeUndefined();
    expect(checkCliForward(e.name, { ...e.fields, extra: 1 })).toBeUndefined();
    expect(checkCliForward(e.name, { ...e.fields, person_id: undefined })).toBeUndefined();
    expect(checkCliForward(e.name, { ...e.fields, os: 'plan9' })).toBeUndefined();
    expect(checkCliForward(e.name, { ...e.fields, session_key: '/tmp/x' })).toBeUndefined();
  });
});
