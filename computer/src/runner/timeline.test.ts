import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Segment, Task } from './segment.js';
import { OPENING, rollup, Timeline, tail } from './timeline.js';

const step = (id: string, over: Partial<Task> = {}): Task => ({ id, name: 'Bash', title: `Bash(${id})`, status: 'complete', ...over });

describe('rollup', () => {
  it('a live run is its latest step, with earlier steps summarized', () => {
    const r = rollup('run-1', [step('a'), step('b', { status: 'error' }), step('c', { status: 'in_progress', elapsed: '5s' })], false);
    expect(r).toMatchObject({ id: 'run-1', title: 'Bash(c)', status: 'in_progress' });
    expect(r.details).toBe('5s · 2 earlier: ✓ Bash · ✗ Bash');
  });

  it('a live run shows the latest step even when nothing is running', () => {
    const r = rollup('run-1', [step('a'), step('b')], false);
    expect(r.title).toBe('Bash(b)');
    expect(r.status).toBe('complete');
    expect(r.details).toBe('1 earlier: ✓ Bash');
  });

  it('merges consecutive repeats in the summary', () => {
    const steps = [step('a'), step('b'), step('c', { name: 'Read', title: 'Read(x)' }), step('d', { status: 'in_progress' })];
    expect(rollup('run-1', steps, false).details).toBe('3 earlier: ✓ Bash ×2 · ✓ Read');
  });

  it('a closed single step stays itself, marked final', () => {
    const r = rollup('run-1', [step('a', { details: '$ ls', output: 'x' })], true);
    expect(r).toEqual({ ...step('a', { details: '$ ls', output: 'x' }), id: 'run-1', final: true });
  });

  it('a closed multi-step run lists every step and the last failure', () => {
    const r = rollup('run-1', [step('a'), step('b', { status: 'error', output: 'boom' }), step('c')], true);
    expect(r.title).toBe('Ran 3 steps · 1 failed');
    expect(r.status).toBe('complete') // the failure was moved past;
    expect(r.details).toBe('✓ Bash(a) · ✗ Bash(b) · ✓ Bash(c)');
    expect(r.output).toBe('boom');
    expect(r.final).toBe(true);
  });

  it('a closed run whose last step succeeded is complete, failures still counted', () => {
    const r = rollup('run-1', [step('a', { status: 'error' }), step('b', { status: 'error' }), step('c')], true);
    expect(r.title).toBe('Ran 3 steps · 2 failed');
    expect(r.status).toBe('complete');
    expect(r.details).toBe('✗ Bash(a) · ✗ Bash(b) · ✓ Bash(c)');
  });

  it('a closed run is an error only when a step was interrupted', () => {
    expect(rollup('run-1', [step('a'), step('b', { status: 'error' })], true).status).toBe('complete');
    expect(rollup('run-1', [step('a'), step('b', { status: 'error', interrupted: true })], true).status).toBe('error');
  });

  it('a closed single failure says so in its title, without the error badge', () => {
    const r = rollup('run-1', [step('a', { status: 'error', output: 'no match' })], true);
    expect(r).toMatchObject({ title: 'Bash(a) · failed', status: 'complete', output: 'no match', final: true });
    expect(rollup('run-1', [step('a', { status: 'error', interrupted: true })], true)).toMatchObject({ title: 'Bash(a)', status: 'error' });
  });

  it('thinking cards count as steps but not as tools', () => {
    const think = step('think-1', { name: undefined, title: 'Thought for 2s' });
    expect(rollup('run-1', [think, step('a')], true).title).toBe('Bash(a)');
    expect(rollup('run-1', [think], true).title).toBe('Thought for 2s');
  });

  it('keeps the closed summary within the details budget', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      step(`s${i}`, i % 2 ? { name: 'Read', title: `Read(file-${i}.ts)` } : { title: `Bash(a long command number ${i})` }),
    );
    const r = rollup('run-1', many, true);
    expect(r.title).toBe('Ran 40 steps');
    expect(r.details!.length).toBeLessThanOrEqual(250);
    expect(r.details).toMatch(/^… · ✓ (Bash|Read)/);
    expect(r.details!.endsWith('✓ Read')).toBe(true);
  });
});

describe('tail', () => {
  it('keeps the end of long text on one line', () => {
    expect(tail('a\n  b   c')).toBe('a b c');
    expect(tail('x'.repeat(300), 10)).toBe('…' + 'x'.repeat(10));
    expect(tail('   ')).toBeUndefined();
  });
});

/** A Segment that only records the cards written to it. */
function fakeSegment() {
  const cards: Task[] = [];
  const ticks: boolean[] = [];
  return { cards, ticks, seg: { task: (t: Task, o?: { tick?: boolean }) => void (cards.push(t), ticks.push(!!o?.tick)) } as unknown as Segment };
}

describe('Timeline', () => {
  it('puts consecutive steps in one run and closes it when text follows', () => {
    const { cards, seg } = fakeSegment();
    const tl = new Timeline(
      () => seg,
      () => seg,
    );
    tl.setTask({ id: 'a', name: 'Read', title: 'Read(x)', status: 'in_progress' });
    tl.patchTask('a', { status: 'complete' });
    tl.setTask({ id: 'b', name: 'Bash', title: 'Bash(ls)', status: 'in_progress' });
    const runId = cards[0].id;
    expect(cards.every((c) => c.id === runId)).toBe(true);
    expect(cards.at(-1)).toMatchObject({ title: 'Bash(ls)', status: 'in_progress', details: '1 earlier: ✓ Read' });

    tl.patchTask('b', { status: 'complete' });
    tl.closeRun();
    expect(cards.at(-1)).toMatchObject({ id: runId, title: 'Ran 2 steps', status: 'complete', final: true });

    tl.setTask({ id: 'c', title: 'Grep(y)', status: 'in_progress' });
    expect(cards.at(-1)!.id).not.toBe(runId);
  });

  it('a run text overtook while a step ran takes no updates until the turn ends', () => {
    vi.useFakeTimers();
    const { cards, seg } = fakeSegment();
    const tl = new Timeline(() => seg, () => seg);
    tl.setTask({ id: 'a', name: 'Bash', title: 'Bash(a)', status: 'complete' });
    tl.setTask({ id: 'b', name: 'Bash', title: 'Bash(b)', status: 'in_progress' });
    const runId = cards[0].id;
    tl.closeRun(); // text follows; b still runs
    const n = cards.length;
    vi.advanceTimersByTime(10_000);
    tl.tick();
    tl.setTask({ id: 'c', title: 'Grep(y)', status: 'in_progress' }); // a later step gets its own card
    expect(cards.slice(n).every((c) => c.id !== runId)).toBe(true);
    tl.endTurn();
    expect(cards.find((c, i) => i >= n && c.id === runId)).toMatchObject({ title: 'Ran 2 steps · 1 failed', status: 'error', final: true });
    vi.useRealTimers();
  });

  it('a new model call drops steps that never ran instead of failing them', () => {
    const { cards, seg } = fakeSegment();
    const tl = new Timeline(() => seg, () => seg);
    tl.setTask({ id: 'a', name: 'Read', title: 'Read(x)', status: 'complete' });
    tl.setTask({ id: 'b', name: 'Bash', title: 'Bash…', status: 'in_progress' });
    tl.abandonRunning();
    expect(cards.at(-1)).toMatchObject({ title: 'Read(x)', status: 'complete' });
    expect(tl.get('b')).toBeUndefined();
    const n = cards.length;
    tl.patchTask('b', { status: 'complete' }); // its result after all: no stray card
    expect(cards).toHaveLength(n);
    tl.closeRun();
    expect(cards.at(-1)).toMatchObject({ title: 'Read(x)', status: 'complete', final: true });
  });

  it('a card whose only step never ran says so', () => {
    const { cards, seg } = fakeSegment();
    const tl = new Timeline(() => seg, () => seg);
    tl.setTask({ id: 'b', name: 'Bash', title: 'Bash…', status: 'in_progress' });
    tl.abandonRunning();
    expect(cards.at(-1)).toMatchObject({ id: cards[0].id, title: 'Bash…', status: 'pending', details: 'not run' });
    tl.endTurn();
    expect(cards.at(-1)!.status).toBe('pending');
  });

  it('sends no update for a step of a closed run, so no card lands mid-text', () => {
    const { cards, seg } = fakeSegment();
    const tl = new Timeline(() => seg, () => seg);
    tl.setTask({ id: 'a', title: 'Bash(a)', status: 'complete' });
    tl.setTask({ id: 'b', title: 'Bash(b)', status: 'error' });
    tl.closeRun();
    const n = cards.length;
    tl.patchTask('a', { details: '↳ late' });
    tl.patchTask('b', { status: 'complete' });
    expect(cards).toHaveLength(n);
    expect(tl.get('b')?.status).toBe('complete');
  });

  it('drops patches for hidden tools', () => {
    const { cards, seg } = fakeSegment();
    const tl = new Timeline(
      () => seg,
      () => seg,
    );
    tl.hide('t');
    tl.patchTask('t', { status: 'complete' });
    expect(cards).toHaveLength(0);
  });

  it('marks running steps interrupted at the end of a turn and forgets them', () => {
    const { cards, seg } = fakeSegment();
    const tl = new Timeline(
      () => seg,
      () => seg,
    );
    tl.setTask({ id: 'a', title: 'Bash(sleep)', status: 'in_progress' });
    tl.endTurn();
    expect(cards.at(-1)).toMatchObject({ title: 'Bash(sleep)', status: 'error', details: 'interrupted', final: true });
    expect(tl.get('a')).toBeUndefined();
  });

  it('starts a new run when the old one went with its message', () => {
    const { cards, seg } = fakeSegment();
    const tl = new Timeline(
      () => seg,
      () => seg,
    );
    tl.setTask({ id: 'a', title: 'Bash(a)', status: 'complete' });
    tl.dropRun();
    tl.setTask({ id: 'b', title: 'Bash(b)', status: 'complete' });
    expect(cards[1].id).not.toBe(cards[0].id);
    expect(cards[1].details).toBeUndefined();
  });

  describe('opening card (work 068)', () => {
    const opened = () => {
      const f = fakeSegment();
      const tl = new Timeline(
        () => f.seg,
        () => f.seg,
      );
      tl.open();
      return { ...f, tl, runId: f.cards[0].id };
    };

    it('opens as `Started`, waiting for its first step', () => {
      const { cards, tl } = opened();
      expect(cards).toEqual([{ id: cards[0].id, title: OPENING, status: 'in_progress', opening: true }]);
      expect(tl.opening).toBe(true);
    });

    it('becomes the thinking card, which ends as "Thought for"', () => {
      const { cards, tl, runId } = opened();
      tl.setTask({ id: 'think-1', title: 'Thinking…', status: 'in_progress' });
      expect(tl.opening).toBe(false);
      expect(cards.at(-1)).toMatchObject({ id: runId, title: 'Thinking…', status: 'in_progress' });
      tl.patchTask('think-1', { title: 'Thought for 2s', status: 'complete' });
      tl.closeRun();
      expect(cards.at(-1)).toMatchObject({ id: runId, title: 'Thought for 2s', status: 'complete', final: true });
    });

    it('becomes the first visible tool card', () => {
      const { cards, tl, runId } = opened();
      tl.setTask({ id: 't1', name: 'Bash', title: 'Bash…', status: 'in_progress' });
      tl.patchTask('t1', { title: 'Bash(npm test)' });
      expect(cards.at(-1)).toMatchObject({ id: runId, title: 'Bash(npm test)', status: 'in_progress' });
    });

    it('text first: completes as `✓ Started`, never "Thought"', () => {
      const { cards, tl, runId } = opened();
      tl.closeRun();
      expect(cards.at(-1)).toEqual({ id: runId, title: OPENING, status: 'complete', final: true, opening: true });
      expect(tl.opening).toBe(false);
      tl.setTask({ id: 'think-2', title: 'Thinking…', status: 'in_progress' });
      expect(cards.at(-1)!.id).not.toBe(runId);
    });

    it('a turn that fails first: an error with the reason', () => {
      const { cards, tl, runId } = opened();
      tl.endTurn('error_max_turns');
      expect(cards.at(-1)).toEqual({ id: runId, title: OPENING, status: 'error', details: 'error_max_turns', final: true, opening: true });
      expect(tl.opening).toBe(false);
    });

    it('waits through the model call starting (nothing of it never ran), and the first step still claims it', () => {
      const { cards, tl, runId } = opened();
      tl.abandonRunning(); // message_start: drops steps that never ran, of which the opening card has none
      expect(cards).toHaveLength(1);
      expect(tl.opening).toBe(true);
      tl.setTask({ id: 'think-1', title: 'Thinking…', status: 'in_progress' });
      expect(cards.at(-1)).toMatchObject({ id: runId, title: 'Thinking…', status: 'in_progress' });
    });

    it('a run emptied of a step that never ran is not an opening card', () => {
      const { cards, seg } = fakeSegment();
      const tl = new Timeline(() => seg, () => seg);
      tl.setTask({ id: 'b', name: 'Bash', title: 'Bash…', status: 'in_progress' });
      tl.abandonRunning();
      expect(tl.opening).toBe(false);
      const n = cards.length;
      tl.closeRun(); // text follows: no `✓ Started` over the `not run` card
      expect(cards).toHaveLength(n);
    });

    it('a hidden tool leaves it waiting for the first visible step', () => {
      const { cards, tl } = opened();
      tl.hide('h1');
      tl.patchTask('h1', { status: 'complete' });
      expect(cards).toHaveLength(1);
      expect(tl.opening).toBe(true);
    });
  });

  describe('tick', () => {
    afterEach(() => vi.useRealTimers());

    it("updates a running step's timer, marked as a tick", () => {
      vi.useFakeTimers();
      const { cards, ticks, seg } = fakeSegment();
      const tl = new Timeline(() => seg, () => seg);
      tl.setTask({ id: 'a', title: 'Bash(sleep 60)', status: 'in_progress' });
      vi.advanceTimersByTime(5000);
      tl.tick();
      expect(cards.at(-1)!.details).toBe('5s');
      expect(ticks).toEqual([false, true]);
    });

    it('leaves a step waiting on the person alone, without a counter', () => {
      vi.useFakeTimers();
      const { cards, seg } = fakeSegment();
      const tl = new Timeline(() => seg, () => seg);
      tl.setTask({ id: 'q', title: 'Question', status: 'in_progress' });
      vi.advanceTimersByTime(5000);
      tl.tick();
      tl.patchTask('q', { details: 'waiting for your answer ↓', waiting: true });
      const before = cards.length;
      vi.advanceTimersByTime(60_000);
      tl.tick();
      expect(cards).toHaveLength(before);
      expect(cards.at(-1)!.details).toBe('waiting for your answer ↓');

      tl.patchTask('q', { details: '→ Blue', waiting: false });
      vi.advanceTimersByTime(3000);
      tl.tick();
      expect(cards.at(-1)!.details).toBe('→ Blue · 1m08s');
    });
  });
});
