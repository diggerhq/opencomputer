import { afterEach, describe, expect, it, vi } from 'vitest';
import { Waiters } from './waiters.js';

type Frame = { t: 'ask'; id: string };
type Answer = { result?: string; error?: string };

function waiters(connected = true) {
  const sent: Frame[] = [];
  const w = new Waiters<Frame, Answer>({ send: (f) => connected && (sent.push(f), true), ms: 1000, late: 'too late' });
  const ask = () => w.ask((id) => ({ t: 'ask', id }), (m) => {
    if (!m.result) throw new Error(m.error ?? 'none');
    return m.result;
  });
  return { w, sent, ask };
}

afterEach(() => void vi.useRealTimers());

describe('Waiters', () => {
  it('resolves with the answer to its own id, rejects with what settle throws', async () => {
    const { w, sent, ask } = waiters();
    const [a, b] = [ask(), ask()];
    w.answer(sent[1].id, { error: 'no' });
    w.answer(sent[0].id, { result: 'yes' });
    await expect(a).resolves.toBe('yes');
    await expect(b).rejects.toThrow('no');
  });

  it('fails unsent with no host; times out once, and a late answer is dropped', async () => {
    await expect(waiters(false).ask()).rejects.toThrow('host not connected');
    vi.useFakeTimers();
    const { w, sent, ask } = waiters();
    const p = ask();
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toThrow('too late');
    w.answer(sent[0].id, { result: 'late' });
  });

  it('answerAll settles every waiting request', async () => {
    const { w, ask } = waiters();
    const ps = [ask(), ask()];
    w.answerAll({ error: 'host restarted' });
    for (const p of ps) await expect(p).rejects.toThrow('host restarted');
  });
});
