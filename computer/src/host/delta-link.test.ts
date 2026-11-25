import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToGateway, JournalDelta, JournalEvent } from '../protocol.js';
import { deltaLink } from './delta-link.js';

const S = 'cs_1';
const msg = (blockId: string, text: string, turnId = 'tn_1') => ({ type: 'message.delta', turnId, data: { subagentId: null, blockId, text } }) as unknown as JournalDelta;
const tool = (callId: string, text: string) => ({ type: 'tool.delta', turnId: 'tn_1', data: { subagentId: null, callId, parentCallId: null, text } }) as unknown as JournalDelta;
const event = (type: string, data: object, turnId = 'tn_1') => ({ type, turnId, data }) as unknown as JournalEvent;

function setup(o: { keepBytes?: number } = {}) {
  const sent: Extract<HostToGateway, { t: 'delta' }>[] = [];
  const s = { buffered: 0, now: 1000, epoch: 3 as number | undefined };
  const link = deltaLink({
    send: (m) => (m.t === 'delta' && sent.push(m), true),
    buffered: () => s.buffered, holdBytes: 100, epoch: () => s.epoch, now: () => s.now, ...o,
  });
  const texts = () => sent.flatMap((f) => f.deltas.map((d) => [(d.data as { text: string }).text, d.offset, d.whole ?? false]));
  return { link, sent, s, texts };
}

describe('deltaLink', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('sends nothing for a session nobody watches, or past the lease', () => {
    const t = setup();
    t.link.delta(S, msg('b1', 'he'));
    vi.advanceTimersByTime(40);
    t.link.watch(S, 2000);
    t.link.delta(S, msg('b1', 'llo'));
    t.s.now = 2000;
    t.link.delta(S, msg('b1', '!'));
    vi.advanceTimersByTime(40);
    expect(t.sent).toEqual([]);
  });

  it('merges a block\'s deltas for 40 ms into one frame per session, each with its offset; the first of a block is whole', () => {
    const t = setup();
    t.link.watch(S, 2000);
    t.link.delta(S, msg('b1', 'he'));
    t.link.delta(S, msg('b1', 'llo'));
    t.link.delta(S, tool('c1', 'out'));
    vi.advanceTimersByTime(39);
    expect(t.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.sent).toEqual([{ t: 'delta', sessionId: S, epoch: 3, deltas: [
      { type: 'message.delta', turnId: 'tn_1', data: { subagentId: null, blockId: 'b1', text: 'hello' }, offset: 0, whole: true },
      { type: 'tool.delta', turnId: 'tn_1', data: { subagentId: null, callId: 'c1', parentCallId: null, text: 'out' }, offset: 0, whole: true },
    ] }]);
    t.link.delta(S, msg('b1', ' there'));
    vi.advanceTimersByTime(40);
    expect(t.texts().at(-1)).toEqual([' there', 5, false]);
  });

  it('counts what it does not send: a watch that begins mid-block and a drop under backpressure leave a gap `block` fills', () => {
    const t = setup();
    t.link.delta(S, msg('b1', 'abc')); // unwatched
    t.link.watch(S, 2000);
    t.link.delta(S, msg('b1', 'de'));
    vi.advanceTimersByTime(40);
    expect(t.texts()).toEqual([['de', 3, false]]);
    t.s.buffered = 101;
    t.link.delta(S, msg('b1', 'fg'));
    vi.advanceTimersByTime(40);
    expect(t.sent).toHaveLength(1); // dropped, never resent
    t.s.buffered = 0;
    t.link.delta(S, msg('b1', 'h'));
    vi.advanceTimersByTime(40);
    expect(t.texts().at(-1)).toEqual(['h', 7, false]);
    t.link.block(S, 'b1');
    expect(t.texts().at(-1)).toEqual(['abcdefgh', 0, true]);
    t.link.block(S, 'nope');
    expect(t.sent).toHaveLength(3);
  });

  it('forgets a block at its completed event, and a turn\'s text blocks at its end', () => {
    const t = setup();
    t.link.watch(S, 2000);
    t.link.delta(S, msg('b1', 'x'));
    t.link.delta(S, msg('b2', 'y'));
    t.link.delta(S, tool('c1', 'z'));
    t.link.event(S, event('message.completed', { blockId: 'b1', subagentId: null }));
    vi.advanceTimersByTime(40);
    expect(t.texts().map((x) => x[0])).toEqual(['y', 'z']); // the completed block's text is the event's
    t.link.event(S, event('turn.completed', {}));
    t.link.block(S, 'b2');
    expect(t.sent).toHaveLength(1);
    t.link.block(S, 'c1');
    expect(t.texts().at(-1)).toEqual(['z', 0, true]);
  });

  it('after the mirror subscribes again the catch-up replaces the block; a block too long to keep is not answered', () => {
    const t = setup({ keepBytes: 4 });
    t.link.watch(S, 2000);
    t.link.delta(S, msg('b1', 'abc'));
    vi.advanceTimersByTime(40);
    t.link.reset(S);
    t.link.delta(S, msg('b1', 'abcd')); // the writer's text so far
    vi.advanceTimersByTime(40);
    expect(t.texts().at(-1)).toEqual(['abcd', 0, true]);
    t.link.delta(S, msg('b1', 'e'));
    vi.advanceTimersByTime(40);
    expect(t.texts().at(-1)).toEqual(['e', 4, false]);
    t.link.block(S, 'b1');
    expect(t.sent).toHaveLength(3);
  });
});
