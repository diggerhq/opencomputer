import { describe, expect, it } from 'vitest';
import type { TraceContext } from '../protocol.js';
import { createTelemetry, type Batch } from '../telemetry/emitter.js';
import fixture from '../telemetry/deliver-trace.fixture.json' with { type: 'json' };
import { decidePath, exitReason, forwardTrace, traceFields } from './trace.js';

const trace = (fixture as { trace: TraceContext }).trace;

describe('host trace', () => {
  it('decides the path after ensureRunner', () => {
    expect(decidePath(undefined)).toBe('warm');
    expect(decidePath({ resumed: false })).toBe('new');
    expect(decidePath({ resumed: true })).toBe('resume');
    expect(decidePath({ resumed: false, prewarmed: true })).toBe('prewarmed');
  });

  it('adds only the path before forwarding; timings are events on the trace', () => {
    expect(forwardTrace(trace)).toEqual({ ...trace, path: 'warm' });
    expect(forwardTrace(trace, { resumed: true })).toEqual({ ...trace, path: 'resume' });
    expect(forwardTrace(trace, { resumed: false, prewarmed: true })).toEqual({ ...trace, path: 'prewarmed' });
  });

  it('gives envelope fields that pass the boundary', async () => {
    const sent: Batch[] = [];
    const t = createTelemetry({ service: 'host', version: 'v', region: 'r', send: (b) => void sent.push(b) });
    t.emit('deliver.received', { ...traceFields('T1:C1:1.2', forwardTrace(trace)), dispatch_id: 'd1', duration_ms: 3 });
    t.emit('deliver.received', traceFields('C1:1.2'));
    await t.flush();
    expect(t.dropped).toEqual({});
    const [e, bare] = sent[0].events;
    expect(e).toMatchObject({ trace_id: trace.id, session_key: 'T1:C1:1.2', person_id: trace.personId, path: 'warm', dispatch_id: 'd1' });
    expect(e.sent_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
    expect(bare).toMatchObject({ session_key: 'C1:1.2' });
    expect(bare.trace_id).toBeUndefined();
  });

  it('names why a runner went', () => {
    expect(exitReason({ exiting: true, report: { status: 'stopped' } })).toBe('idle');
    expect(exitReason({ report: { status: 'stopped' } })).toBe('stopped');
    expect(exitReason({ report: { status: 'busy' } })).toBe('unknown');
  });
});
