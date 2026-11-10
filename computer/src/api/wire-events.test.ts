import { describe, expect, it } from 'vitest';
import { mintId } from '../session-ids.js';
import { checkWireEvent, closeCode, WIRE_EVENTS } from './wire-events.js';

const sid = mintId('cs');

describe('checkWireEvent', () => {
  it('lifts the envelope out and keeps the data keys of the table', () => {
    const r = checkWireEvent('wire.attach', {
      connection_id: 'wc_abc', session_key: sid, person_id: 'usr_1', duration_ms: 12.4, outcome: 'completed',
      attach_ms: 3.6, via: 'method', resume: false, replay: true, deltas: true,
    });
    expect(r).toEqual({
      name: 'wire.attach',
      envelope: { session_key: sid, person_id: 'usr_1', duration_ms: 12, outcome: 'completed' },
      data: { connection_id: 'wc_abc', attach_ms: 4, via: 'method', resume: false, replay: true, deltas: true },
    });
  });

  it('skips undefined values', () => {
    expect(checkWireEvent('wire.files', { op: 'list', bytes: undefined, error_code: undefined })?.data).toEqual({ op: 'list' });
  });

  it('drops the whole event on an unknown name, key or value (forbidden shapes)', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['wire.nope', {}],
      ['wire.connect', { connection_id: 'wc_1', path: '/etc/passwd' }],
      ['wire.connect', { connection_id: '../x' }],
      ['wire.error', { method: 'turns.send', code: 'Not A Code' }],
      ['wire.error', { method: 'rm -rf /', code: 'x' }],
      ['wire.files', { op: 'delete' }],
      ['wire.files', { op: 'get', bytes: -1 }],
      ['wire.files', { op: 'get', bytes: Number.NaN }],
      ['wire.flush', { frames: '3' }],
      ['wire.flush', { paused: 'yes' }],
      ['wire.close', { code: 1234 }],
      ['wire.refused', { status: 500 }],
      ['wire.detached', { reason: 'because I said so' }],
      ['wire.attach', { session_key: 'not-a-session' }],
      ['wire.attach', { person_id: 'a person with spaces' }],
      ['wire.attach', { outcome: 'maybe' }],
      ['wire.attach', { error_code: 'ENOENT: /home/x' }],
      ['wire.telemetry', { result: 'ok', text: 'hello world' }],
    ];
    for (const [name, fields] of bad) expect(checkWireEvent(name, fields), `${name} ${JSON.stringify(fields)}`).toBeUndefined();
    expect(checkWireEvent('wire.connect', null)).toBeUndefined();
    expect(checkWireEvent('wire.connect', [])).toBeUndefined();
  });

  it('keeps every value a number, a boolean or a short closed string', () => {
    for (const keys of Object.values(WIRE_EVENTS)) for (const k of keys) expect(k).toMatch(/^[a-z_]+$/);
  });

  it('maps a close code outside the list to 0 (other)', () => {
    expect(closeCode(4001)).toBe(4001);
    expect(closeCode(3999)).toBe(0);
    expect(checkWireEvent('wire.close', { code: closeCode(3999) })?.data).toEqual({ code: 0 });
  });
});
