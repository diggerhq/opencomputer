// `api.write` (work 084 instrumentation, Q8): one event per API write call the
// runner's SessionApi takes, emitted when the call returns. duration_ms is the
// call's own time here: the message handed to the harness for a start or a
// steer; the answer for an interrupt (the turn's ending is its journal events).
//
// Invariants: no content. The method is one of a closed list, the delivery is
// the result's, the error code the API's own (`[a-z_]`); the person is the
// actor id; `surface` is `cli` for opc, else `api`.

import type { CallContext, CallOutcome } from '../../api/writer.js';
import type { Telemetry } from '../../telemetry/emitter.js';

export const WRITE_METHODS = ['turns.send', 'sessions.interrupt', 'asks.answer', 'sessions.update', 'sessions.suspend', 'subagents.stop', 'turns.cancel'] as const;
export const DELIVERIES = ['started', 'queued', 'steered', 'interrupt', 'none'] as const;
const CODE = /^[a-z_]{1,40}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ApiWrite {
  method: string;
  params: unknown;
  ctx: CallContext;
  ms: number;
  out: CallOutcome;
}

export function apiWriteEvent(t: Telemetry) {
  return ({ method, params, ctx, ms, out }: ApiWrite) => {
    const r = (out.result ?? {}) as { delivery?: unknown; duplicate?: unknown };
    const ifBusy = (params as { ifBusy?: unknown } | undefined)?.ifBusy;
    let delivery: (typeof DELIVERIES)[number] = (DELIVERIES as readonly unknown[]).includes(r.delivery) ? (r.delivery as (typeof DELIVERIES)[number]) : 'none';
    if (method === 'turns.send' && ifBusy === 'interrupt' && delivery === 'started') delivery = 'interrupt';
    const code = out.error?.code;
    t.emit('api.write', {
      surface: ctx.actor.via === 'opc' ? 'cli' : 'api',
      ...(ID.test(ctx.actor.id) ? { person_id: ctx.actor.id } : {}),
      duration_ms: Math.max(0, Math.round(ms)),
      outcome: out.error ? 'failed' : 'completed',
      ...(code ? { error_code: CODE.test(code) ? code : 'other' } : {}),
      data: {
        method: (WRITE_METHODS as readonly string[]).includes(method) ? method : 'other',
        delivery: method === 'turns.send' ? delivery : 'none',
        replayed: r.duplicate === true,
      },
    });
  };
}
