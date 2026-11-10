import { describe, expect, it } from 'vitest';
import { type Batch, createTelemetry } from '../../telemetry/emitter.js';
import type { TelemetryEvent } from '../../telemetry/envelope.js';
import { apiWriteEvent } from './write-events.js';

function setup() {
  const batches: Batch[] = [];
  const t = createTelemetry({ service: 'runner', version: 'r1', region: 'local', send: (b) => void batches.push(b) });
  const out = async () => {
    await t.flush();
    expect(t.dropped).toEqual({});
    return batches.flatMap((b) => b.events) as TelemetryEvent[];
  };
  return { on: apiWriteEvent(t), out };
}

const ctx = (via: string) => ({ actor: { id: 'usr_1', name: 'Ann', via, client: null }, member: 'usr_1' });

describe('api.write', () => {
  it('one event per write: method, delivery, replayed, the call\'s time; surface cli for opc', async () => {
    const { on, out } = setup();
    on({ method: 'turns.send', params: { input: 'please delete /etc', ifBusy: 'steer' }, ctx: ctx('opc'), ms: 12.6, out: { result: { delivery: 'steered', duplicate: false } } });
    on({ method: 'turns.send', params: { input: 'x', ifBusy: 'interrupt' }, ctx: ctx('api'), ms: 3, out: { result: { delivery: 'started', duplicate: true } } });
    on({ method: 'asks.answer', params: { askId: 'ask_1', answer: 'yes' }, ctx: ctx('api'), ms: 1, out: { error: { code: 'ask_closed', message: 'the ask is answered', status: 409 } as never } });
    on({ method: 'some.future', params: {}, ctx: ctx('dashboard'), ms: 1, out: { result: {} } });
    const e = await out();
    expect(e.map((x) => [x.surface, x.duration_ms, x.outcome, x.error_code ?? null, x.data])).toEqual([
      ['cli', 13, 'completed', null, { method: 'turns.send', delivery: 'steered', replayed: false }],
      ['api', 3, 'completed', null, { method: 'turns.send', delivery: 'interrupt', replayed: true }],
      ['api', 1, 'failed', 'ask_closed', { method: 'asks.answer', delivery: 'none', replayed: false }],
      ['api', 1, 'completed', null, { method: 'other', delivery: 'none', replayed: false }],
    ]);
    expect(JSON.stringify(e)).not.toMatch(/delete|etc|yes|the ask is/); // no input, answer or message
    expect(e[0].person_id).toBe('usr_1');
  });
});
