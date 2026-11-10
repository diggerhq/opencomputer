import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { checkEvent } from '../telemetry/validate.js';
import { createTelemetry, type Batch } from '../telemetry/emitter.js';
import { cpuPct, diskReport, hostSampler } from './sample.js';

describe('host.sample', () => {
  it('measures CPU busy share between readings', () => {
    expect(cpuPct({ idle: 100, total: 200 }, { idle: 175, total: 300 })).toBe(25);
    expect(cpuPct({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeUndefined();
  });

  it('samples the machine and passes the boundary', async () => {
    const sample = hostSampler(tmpdir());
    const data = sample({ runners: 2, busy_runners: 1, gateway_connected: false, telemetry_spooled_bytes: 10, telemetry_dropped: 0 });
    expect(data).toMatchObject({ runners: 2, busy_runners: 1, gateway_connected: false });
    expect(typeof data.load1).toBe('number');
    expect(typeof data.mem_used_mb).toBe('number');
    expect(typeof data.disk_free_mb).toBe('number');
    expect('oldest_fetch_age_s' in data).toBe(false);
    const sent: Batch[] = [];
    const t = createTelemetry({ service: 'host', version: 'v', region: 'r', send: (b) => void sent.push(b) });
    t.emit('host.sample', { data });
    await t.flush();
    expect(t.dropped).toEqual({});
    expect(checkEvent(sent[0].events[0]).ok).toBe(true);
  });
});

describe('diskReport', () => {
  it('reports the data volume for the gateway (work 071)', () => {
    const r = diskReport(tmpdir());
    expect(r?.t).toBe('disk');
    expect(r!.totalBytes).toBeGreaterThan(0);
    expect(r!.freeBytes).toBeGreaterThanOrEqual(0);
    expect(r!.freeBytes).toBeLessThanOrEqual(r!.totalBytes);
  });

  it('is undefined for a path it cannot read', () => {
    expect(diskReport('/nonexistent/sp-data')).toBeUndefined();
  });
});
