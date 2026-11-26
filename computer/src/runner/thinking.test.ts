import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from './segment.js';
import { OPENING_THINKING_CARD_MS, THINKING_CARD_MS, ThinkingCards } from './thinking.js';

function sink() {
  const tasks = new Map<string, Task>();
  return {
    tasks,
    setTask: (t: Task) => void tasks.set(t.id, t),
    patchTask: (id: string, p: Partial<Task>) => void tasks.set(id, { ...tasks.get(id)!, ...p }),
  };
}

describe('ThinkingCards', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows nothing for a block that ends before its card is due', () => {
    const s = sink();
    const c = new ThinkingCards(s);
    c.start('0');
    vi.advanceTimersByTime(THINKING_CARD_MS - 1);
    c.stop('0');
    vi.advanceTimersByTime(10_000);
    expect(s.tasks.size).toBe(0);
  });

  it('shows a card once due, rolls notes into it, and ends as "Thought for"', () => {
    const s = sink();
    const c = new ThinkingCards(s);
    c.start('0');
    c.delta('0', 'hmm');
    vi.advanceTimersByTime(THINKING_CARD_MS);
    const [t] = [...s.tasks.values()];
    expect(t).toMatchObject({ title: 'Thinking…', status: 'in_progress', details: 'hmm' });
    c.delta('0', ' more');
    expect(s.tasks.get(t.id)?.details).toBe('hmm more');
    vi.advanceTimersByTime(1500);
    c.stop('0');
    expect(s.tasks.get(t.id)).toMatchObject({ title: 'Thought for 3s', status: 'complete' });
  });

  it('reports each card shown, at the delay asked for', () => {
    const s = sink();
    let shown = 0;
    const c = new ThinkingCards(s, () => shown++);
    c.start('0', 300);
    vi.advanceTimersByTime(299);
    expect(shown).toBe(0);
    vi.advanceTimersByTime(1);
    expect(shown).toBe(1);
    expect(s.tasks.size).toBe(1);
  });

  it('delay 0 (the turn\'s open `Started` card): shows at once, notes from the first delta', () => {
    const s = sink();
    let shown = 0;
    const c = new ThinkingCards(s, () => shown++);
    c.start('0', OPENING_THINKING_CARD_MS);
    expect(shown).toBe(1);
    const [t] = [...s.tasks.values()];
    expect(t).toMatchObject({ title: 'Thinking…', status: 'in_progress' });
    c.delta('0', 'first');
    expect(s.tasks.get(t.id)?.details).toBe('first');
    c.stop('0');
    expect(s.tasks.get(t.id)).toMatchObject({ title: 'Thought for 1s', status: 'complete' });
  });

  it('clear drops cards not yet shown', () => {
    const s = sink();
    const c = new ThinkingCards(s);
    c.start('0');
    c.clear();
    vi.advanceTimersByTime(10_000);
    expect(s.tasks.size).toBe(0);
  });
});
