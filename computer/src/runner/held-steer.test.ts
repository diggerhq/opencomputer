import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELD_STEER_MS, HeldSteer } from './held-steer.js';

afterEach(() => vi.useRealTimers());

function held(running: { title: string; ms: number } | null = { title: 'Bash(gh run watch 1)', ms: 95_000 }) {
  vi.useFakeTimers();
  const said: string[] = [];
  return { h: new HeldSteer({ running: () => running ?? undefined, say: (t) => said.push(t) }), said };
}

describe('HeldSteer: a message waiting behind a slow step', () => {
  it('says what it waits on once the wait passes HELD_STEER_MS', () => {
    const { h, said } = held();
    h.arm();
    vi.advanceTimersByTime(HELD_STEER_MS - 1);
    expect(said).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["Still in `Bash(gh run watch 1)` (1m35s). I'll read your message when it finishes; start a message with `!!` to stop it now."]);
  });

  it('one notice per wait, however many messages join it', () => {
    const { h, said } = held();
    h.arm();
    vi.advanceTimersByTime(HELD_STEER_MS);
    h.arm();
    vi.advanceTimersByTime(HELD_STEER_MS * 3);
    expect(said).toHaveLength(1);
  });

  it('nothing once a tool result carried the message', () => {
    const { h, said } = held();
    h.arm();
    vi.advanceTimersByTime(HELD_STEER_MS / 2);
    h.cancel();
    vi.advanceTimersByTime(HELD_STEER_MS);
    expect(said).toEqual([]);
  });

  it('nothing while no step runs, and it can arm again', () => {
    const { h, said } = held(null);
    h.arm();
    vi.advanceTimersByTime(HELD_STEER_MS);
    expect(said).toEqual([]);
    h.arm();
    vi.advanceTimersByTime(HELD_STEER_MS);
    expect(said).toEqual([]);
  });
});
