import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkWireEvent, type WireFields } from '../api/wire-events.js';
import { FlushWindow } from './telemetry.js';

afterEach(() => void vi.useRealTimers());

describe('FlushWindow', () => {
  it('emits one wire.flush per window, not one per frame, and none when idle', () => {
    vi.useFakeTimers({ now: 10_000 });
    const out: WireFields[] = [];
    const w = new FlushWindow((f) => out.push(f), () => 7, 1000, Date.now);
    for (let i = 0; i < 50; i++) {
      w.frame(100);
      if (i % 2) w.event(9_000, 3);
      else w.delta(5);
    }
    w.merge();
    w.duplicate();
    w.pause();
    vi.advanceTimersByTime(999);
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([
      { frames: 50, bytes: 5000, events: 25, deltas: 25, wait_ms_max: 5, queued_bytes: 7, paused: true, merged: 1, duplicates: 1, oldest_age_ms: 2000 },
    ]);
    vi.advanceTimersByTime(10_000);
    expect(out).toHaveLength(1);
    w.frame(10);
    w.close();
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ frames: 1, bytes: 10, events: 0, paused: false });
    expect(out[1].oldest_age_ms).toBeUndefined();
    for (const f of out) expect(checkWireEvent('wire.flush', { connection_id: 'wc_1', ...f })).toBeDefined();
  });

  it('leaves out a replayed event or a bad createdAt from the age', () => {
    vi.useFakeTimers({ now: 10_000 });
    const out: WireFields[] = [];
    const w = new FlushWindow((f) => out.push(f), () => 0, 1000, Date.now);
    w.frame(1);
    w.event(undefined, 0);
    w.event(Number.NaN, 0);
    w.close();
    expect(out[0].oldest_age_ms).toBeUndefined();
    w.close();
    expect(out).toHaveLength(1);
  });
});
