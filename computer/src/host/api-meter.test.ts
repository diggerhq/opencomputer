import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCliFrame } from '../api/cli-telemetry.js';
import { mintId } from '../session-ids.js';
import { type Batch, createTelemetry } from '../telemetry/emitter.js';
import type { TelemetryEvent } from '../telemetry/envelope.js';
import { apiMeter } from './api-meter.js';

const T0 = Date.UTC(2026, 9, 26, 12);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const journals = mkdtempSync(path.join(tmpdir(), 'api-meter-'));
  dirs.push(journals);
  const batches: Batch[] = [];
  let now = T0;
  const t = createTelemetry({ service: 'host', version: 'h1', region: 'local', send: (b) => void batches.push(b), now: () => now });
  const meter = apiMeter(t, { journals, intervalMs: 3_600_000, now: () => now });
  const out = async () => {
    await t.flush();
    expect(t.dropped).toEqual({}); // every event matches the catalog
    return batches.splice(0).flatMap((b) => b.events) as TelemetryEvent[];
  };
  return { meter, out, journals, tick: (ms: number) => (now += ms) };
}

const sid = mintId('cs');

describe('apiMeter: the relay\'s events (the fix: wire.sock telemetry reaches the spool)', () => {
  it('emits each checked wire.* event with surface cli and the envelope lifted out', async () => {
    const { meter, out } = setup();
    meter.wire('wire.attach', { connection_id: 'wc_1', session_key: sid, person_id: 'usr_1', duration_ms: 4, outcome: 'completed', attach_ms: 4, via: 'url', resume: false, replay: true, deltas: true });
    meter.wire('wire.close', { connection_id: 'wc_1', code: 1000, attaches: 1, frames_in: 3, bytes_in: 300, frames_out: 9, bytes_out: 9000, duration_ms: 5000 });
    const [a, c] = await out();
    expect(a).toMatchObject({ event_name: 'wire.attach', service_name: 'host', surface: 'cli', session_key: sid, person_id: 'usr_1', duration_ms: 4, outcome: 'completed' });
    expect(a.data).toEqual({ connection_id: 'wc_1', attach_ms: 4, via: 'url', resume: false, replay: true, deltas: true });
    expect(c).toMatchObject({ event_name: 'wire.close', duration_ms: 5000, data: { code: 1000, frames_out: 9 } });
    meter.stop();
  });

  it('emits opc\'s events at the client time with surface cli; drops anything off', async () => {
    const { meter, out } = setup();
    const frame = { v: 1, client: { name: 'opc', version: '0.1.0', os: 'linux', arch: 'x64' }, events: [{ name: 'cli.render', at: T0 - 2000, sessionId: sid, data: { lag_ms: 140, draw_ms: 30 } }] };
    const [e] = checkCliFrame(frame, 200, { member: 'usr_1', maySee: () => true, now: () => T0 }).events;
    meter.wire(e.name, e.fields);
    meter.wire(e.name, { ...e.fields, text: 'secret' });
    meter.wire('wire.connect', { connection_id: 'wc_1', path: '/home/me' });
    meter.wire('host.anything', {});
    const events = await out();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_name: 'cli.render', surface: 'cli', person_id: 'usr_1', session_key: sid, data: { lag_ms: 140, draw_ms: 30, client_version: '0.1.0', os: 'linux', arch: 'x64' } });
    expect(events[0].occurred_at).toBe(new Date(T0 - 2000).toISOString().replace('T', ' ').replace('Z', ''));
    meter.stop();
  });
});

describe('apiMeter: the host\'s own units', () => {
  it('mirror.batch and mirror.ack, one per unit', async () => {
    const { meter, out, tick } = setup();
    const e = (seq: number) => ({ id: `ev_${seq}`, seq, createdAt: new Date(T0).toISOString(), sessionId: sid, turnId: 'tn_1', type: 'x', actor: { via: 'slack' }, data: {} }) as never;
    meter.mirror.batch(sid, [e(1), e(2)], true);
    tick(30);
    meter.mirror.acked(sid, 2);
    const [b, a] = await out();
    expect(b).toMatchObject({ event_name: 'mirror.batch', session_key: sid, turn_id: 'tn_1', surface: 'slack', data: { events: 2, first_seq: 1, last_seq: 2, resent: false, urgent: true } });
    expect(a).toMatchObject({ event_name: 'mirror.ack', session_key: sid, data: { seq: 2, batches: 1, events: 2, commit_ms: 30, age_ms: 30 } });
    meter.stop();
  });

  it('api.held per held frame (asked when the host asked), api.stale_epoch once per session and epoch, api.epoch_adopted per adoption', async () => {
    const { meter, out, tick } = setup();
    const went = meter.held(sid);
    tick(1200);
    meter.asked(sid);
    went();
    meter.staleDrop(sid, 2, 3);
    meter.staleDrop(sid, 2, 3);
    meter.staleDrop(sid, 1, 3);
    meter.adopted({ sessionId: sid, epoch: 3, startSeq: 10, tailEvents: 2, torn: false, heldFrames: 1, retiredRunner: true, attempt: 1, ms: 40, ok: true });
    const events = await out();
    expect(events.map((e) => e.event_name)).toEqual(['api.held', 'api.stale_epoch', 'api.stale_epoch', 'api.epoch_adopted']);
    expect(events[0]).toMatchObject({ duration_ms: 1200, data: { asked: true } });
    expect(events[1].data).toEqual({ epoch: 2, known: 3 });
    expect(events[3]).toMatchObject({ duration_ms: 40, outcome: 'completed', data: { epoch: 3, attempt: 1 } });
    meter.stop();
  });

  it('api.sample carries gauges only, and nothing on a v3 host', async () => {
    const { meter, out, journals } = setup();
    await meter.sample();
    expect(await out()).toEqual([]);
    mkdirSync(path.join(journals, sid));
    writeFileSync(path.join(journals, sid, `${sid}.jsonl`), 'x'.repeat(100));
    // Not journals: a file directly in journals/ (the layout before work 103), and a link where a journal would be.
    writeFileSync(path.join(journals, `${sid}.jsonl`), 'x'.repeat(7));
    const linked = mintId('cs');
    mkdirSync(path.join(journals, linked));
    symlinkSync(path.join(journals, sid, `${sid}.jsonl`), path.join(journals, linked, `${linked}.jsonl`));
    meter.setGauges(() => ({ v4: true, runnerWriters: 2, hostWriters: 1, heldFrames: 0, mirrorSpooledBytes: 5 }));
    await meter.sample();
    const [s] = await out();
    expect(s.event_name).toBe('api.sample');
    expect(s.data).toEqual({ host_protocol: 4, open_journals: 3, runner_writers: 2, host_writers: 1, journal_bytes: 100, mirror_spooled_bytes: 5, mirror_unacked_max: 0, held_frames: 0 });
    meter.stop();
  });
});
