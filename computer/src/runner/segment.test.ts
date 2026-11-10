import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { atBreak, Segment, summarize, type Item, type Task } from './segment.js';
import { placeholderWrites, queuedSince } from './surface-meter.js';

const text = (t: string): Item => ({ kind: 'text', text: t });
const card = (title: string, status: Task['status'] = 'complete'): Item => ({ kind: 'task', task: { id: title, title, status } });

describe('summarize (folded history)', () => {
  it('keeps narration and counts the steps after it, without their titles', () => {
    const lines = summarize([
      text('Reading the host.'),
      card("Bash(python3 - <<'EOF' …)"),
      text('Now the runner:'),
      card('Ran 3 steps · 1 failed', 'error'),
      card('Read(a.ts)'),
    ]);
    expect(lines).toEqual(['Reading the host. · 1 step', 'Now the runner: · 4 steps (1 failed)']);
  });

  it('steps with no narration before them get their own line', () => {
    expect(summarize([card('Ran 2 steps'), text('Done.')])).toEqual(['2 steps', 'Done.']);
  });

  it('an opening card that ended as `✓ Started` is no step', () => {
    const opened: Item = { kind: 'task', task: { id: 'run-1', title: 'Started', status: 'complete', opening: true } };
    expect(summarize([opened, text('Hi.')])).toEqual(['Hi.']);
  });

  it('clips long narration and escapes Slack markup', () => {
    const [line] = summarize([text(`<b> ${'x'.repeat(300)}`)]);
    expect(line.startsWith('&lt;b&gt;')).toBe(true);
    expect(line.length).toBeLessThan(180);
  });
});

/** A Slack client that records chat.* calls in order. */
function recorder(fail: string[] = []) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const rec = (method: string) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    if (fail.includes(method) && args.chunks) throw new Error('stream_closed');
    return { ok: true, ts: '1.1' };
  };
  const client = {
    chat: { startStream: rec('startStream'), appendStream: rec('appendStream'), stopStream: rec('stopStream'), postMessage: rec('postMessage') },
  } as unknown as WebClient;
  return { calls, client };
}
const target = { channel: 'C1', threadTs: '1.0', recipientUserId: 'U1' };

describe('Segment: native flush cadence', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('shows text and tool changes immediately after idle gaps', async () => {
    const { client, calls } = recorder();
    const seg = new Segment(client, target);
    seg.text('Checking.');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2000);
    seg.task({ id: 'tool', title: 'Bash(ls)', status: 'in_progress' });
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream']);
    await vi.advanceTimersByTimeAsync(2000);
    seg.text('Found it.');
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'appendStream']);
    expect(queuedSince.get(calls[2].args)).toBeGreaterThanOrEqual(performance.now() - 1);
    await seg.close();
  });

  it('coalesces continuous output and waits only the remaining interval', async () => {
    const { client, calls } = recorder();
    const seg = new Segment(client, target);
    seg.text('A');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(399);
    seg.text('B');
    await vi.advanceTimersByTimeAsync(100);
    seg.text('C');
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(2);
    expect(calls[1].args.chunks).toEqual([{ type: 'markdown_text', text: 'BC' }]);
    await seg.close();
  });

  it('coalesces updates while Slack is slow instead of queueing flushes', async () => {
    const { client, calls } = recorder();
    let release!: () => void;
    const append = client.chat.appendStream;
    client.chat.appendStream = (async (args: Parameters<typeof append>[0]) => {
      await new Promise<void>((r) => (release = r));
      return append(args);
    }) as typeof append;
    const seg = new Segment(client, target);
    seg.text('A');
    await vi.advanceTimersByTimeAsync(1000);
    seg.text('B');
    await vi.advanceTimersByTimeAsync(1);
    seg.text('C');
    await vi.advanceTimersByTimeAsync(1000);
    seg.text('D');
    await vi.advanceTimersByTimeAsync(1000);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[1].args.chunks).toEqual([{ type: 'markdown_text', text: 'B' }]);
    // C and D share the one next write, even though more than a flush interval passed between them.
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[2].args.chunks).toEqual([{ type: 'markdown_text', text: 'CD' }]);
    await seg.close();
  });

  it('close cancels the pending flush and sends the content once', async () => {
    const { client, calls } = recorder();
    const seg = new Segment(client, target);
    seg.text('A');
    await vi.advanceTimersByTimeAsync(1);
    seg.text('B');
    await seg.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    expect(calls[1].args.chunks).toEqual([{ type: 'markdown_text', text: 'B' }]);
  });
});

describe('Segment', () => {
  it('posts nothing before `after` settles (the intro reads above it)', async () => {
    const { calls, client } = recorder();
    let introDone!: () => void;
    const intro = new Promise<void>((r) => (introDone = r));
    const seg = new Segment(client, target, intro.then(() => void calls.push({ method: 'intro', args: {} })));
    seg.text('hello');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    introDone();
    await seg.close();
    expect(calls.map((c) => c.method).slice(0, 2)).toEqual(['intro', 'startStream']);
  });

  /** A segment whose stream is open, with more text pending. */
  async function streaming(fail: string[] = []) {
    const r = recorder(fail);
    const seg = new Segment(r.client, target);
    seg.text('one');
    await new Promise((res) => setTimeout(res, 20)); // the first flush opens the stream
    seg.text(' two');
    return { ...r, seg };
  }
  const footer = [{ type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text: 'f' }] }];

  it('ends a stream in one call: pending chunks, footer and status go with stopStream', async () => {
    const { calls, seg } = await streaming();
    expect(await seg.close({ blocks: footer, sessionStatus: 'active' })).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    expect(calls[1].args).toMatchObject({ chunks: [{ type: 'markdown_text', text: ' two' }], blocks: footer, session_status: 'active' });
  });

  it('appends the chunks first when stopStream refuses them', async () => {
    const { calls, seg } = await streaming(['stopStream']);
    expect(await seg.close({ sessionStatus: 'active' })).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream', 'appendStream', 'stopStream']);
    expect(calls[2].args).toMatchObject({ chunks: [{ type: 'markdown_text', text: ' two' }] });
    expect(calls[3].args.chunks).toBeUndefined();
  });

  it('stamps a write with when its oldest change was made; a timer tick alone is no change', async () => {
    const before = performance.now();
    const { calls, seg } = await streaming();
    const opened = queuedSince.get(calls[0].args)!;
    expect(opened).toBeGreaterThanOrEqual(before);
    await seg.close();
    expect(queuedSince.get(calls[1].args)).toBeGreaterThan(opened); // ' two' came after the stream opened
    const r = recorder();
    const idle = new Segment(r.client, target);
    idle.task({ id: 't', title: 'Bash(ls)', status: 'in_progress' }, { tick: true });
    await idle.close();
    expect(r.calls.every((c) => !queuedSince.has(c.args))).toBe(true);
  });

  it('a refused write puts its stamp back on the content it retries', async () => {
    const { calls, seg } = await streaming(['stopStream']);
    await seg.close();
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream', 'appendStream', 'stopStream']);
    expect(queuedSince.get(calls[2].args)).toBe(queuedSince.get(calls[1].args));
    expect(queuedSince.has(calls[3].args)).toBe(false);
  });

  it('a message never streamed posts the footer instead, and reports no status set', async () => {
    const { calls, client } = recorder();
    expect(await new Segment(client, target).close({ blocks: footer, sessionStatus: 'active' })).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['postMessage']);
  });
});

/**
 * A client whose stream Slack ends on `expire()`, as it does about 10 minutes
 * after chat.startStream: later appends fail with message_not_in_streaming_state.
 */
function expiring() {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let n = 0;
  let open = '';
  const chat = {
    startStream: async (args: Record<string, unknown>) => {
      calls.push({ method: 'startStream', args });
      open = `1.${++n}`;
      return { ok: true, ts: open };
    },
    appendStream: async (args: Record<string, unknown>) => {
      calls.push({ method: 'appendStream', args });
      if (args.ts !== open) throw Object.assign(new Error('An API error occurred'), { data: { ok: false, error: 'message_not_in_streaming_state' } });
      return { ok: true };
    },
    stopStream: async (args: Record<string, unknown>) => (calls.push({ method: 'stopStream', args }), { ok: true }),
    postMessage: async (args: Record<string, unknown>) => (calls.push({ method: 'postMessage', args }), { ok: true, ts: '9.9' }),
  };
  return { calls, client: { chat } as unknown as WebClient, expire: () => (open = '') };
}
const flushed = () => new Promise((r) => setTimeout(r, 700)); // past the 600 ms flush timer

describe('Segment: the opening card (work 068)', () => {
  const opening: Task = { id: 'run-1', title: 'Started', status: 'in_progress', opening: true };

  it('the first real change after it goes out at once, then the usual interval', async () => {
    const { calls, client } = recorder();
    const seg = new Segment(client, target);
    seg.task(opening);
    await new Promise((r) => setTimeout(r, 20));
    seg.task({ id: 'run-1', title: 'Bash(ls)', status: 'in_progress' });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream']);
    seg.text('more');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(2); // batched again
  });

  it('marks the write that shows only it for telemetry, not one that carries content', async () => {
    const a = recorder();
    const only = new Segment(a.client, target);
    only.task(opening);
    await new Promise((r) => setTimeout(r, 20));
    expect(placeholderWrites.has(a.calls[0].args)).toBe(true);
    const b = recorder();
    const mixed = new Segment(b.client, target);
    mixed.task(opening);
    mixed.text('Hi.');
    await new Promise((r) => setTimeout(r, 20));
    expect(placeholderWrites.has(b.calls[0].args)).toBe(false);
  });

  it('ended as `✓ Started`, it does not count toward folding', () => {
    const seg = new Segment(recorder().client, target);
    seg.task({ ...opening, status: 'complete', final: true });
    seg.task({ id: 'run-2', title: 'Read(x)', status: 'complete' });
    expect(seg.cards).toBe(1);
  });

  it('a status given as a function is decided when the stream stops', async () => {
    const { calls, client } = recorder();
    const seg = new Segment(client, target);
    seg.text('one');
    await new Promise((r) => setTimeout(r, 20));
    let busy = false;
    const closing = seg.close({ sessionStatus: () => (busy ? undefined : 'active') });
    busy = true;
    await closing;
    expect(calls.at(-1)).toMatchObject({ method: 'stopStream' });
    expect(calls.at(-1)!.args.session_status).toBeUndefined();
  });
});

describe('Segment after Slack ends the stream', () => {
  const waiting: Task = { id: 'run-1', title: 'Question', status: 'in_progress', details: 'waiting for your answer ↓' };

  it('a timer tick opens no new message; the next real change opens one', async () => {
    const { calls, client, expire } = expiring();
    const seg = new Segment(client, target);
    seg.task(waiting);
    await new Promise((r) => setTimeout(r, 20));
    expire();
    seg.task({ ...waiting, details: 'waiting for your answer ↓ · 10m01s' }, { tick: true });
    await flushed();
    seg.task({ ...waiting, details: 'waiting for your answer ↓ · 10m04s' }, { tick: true });
    await flushed();
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream']);

    seg.task({ ...waiting, status: 'complete', details: '→ Blue' });
    await flushed();
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'startStream']);
    expect(calls[2].args.chunks).toMatchObject([{ type: 'task_update', id: 'run-1', status: 'complete' }]);
  });

  it('text after the stream ended still opens a new message, with it', async () => {
    const { calls, client, expire } = expiring();
    const seg = new Segment(client, target);
    seg.text('one');
    await new Promise((r) => setTimeout(r, 20));
    expire();
    seg.text(' two');
    await flushed();
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'startStream']);
    expect(calls[2].args.chunks).toEqual([{ type: 'markdown_text', text: ' two' }]);
  });
});

describe('rotation (a message ends only where markdown survives the cut)', () => {
  it('atBreak: at a line end, outside a code fence', () => {
    expect(atBreak('Done.\n')).toBe(true);
    expect(atBreak('Done.')).toBe(false);
    // A link is safe only because a paragraph is one line: the break is at its end.
    expect(atBreak('See [the PR](https://exa')).toBe(false);
    expect(atBreak('```ts\nconst a = 1;\n')).toBe(false);
    expect(atBreak('```ts\nconst a = 1;\n```\n')).toBe(true);
    expect(atBreak('~~~sh\nls\n')).toBe(false);
    expect(atBreak('~~~sh\nls\n~~~\n')).toBe(true);
    // A longer fence may quote shorter ones without closing.
    expect(atBreak('````md\n```\ncode\n```\n')).toBe(false);
    expect(atBreak('````md\n```\ncode\n```\n````\n')).toBe(true);
    expect(atBreak('```\n~~~\n')).toBe(false);
  });

  it('a big segment waits for a break, but not past the hard cap', () => {
    const seg = new Segment(recorder().client, target);
    seg.text(`${'x'.repeat(9000)}\n\`\`\`sh\nls\n`);
    expect(seg.full).toBe(false);
    seg.text('```\n');
    expect(seg.full).toBe(true);
    const open = new Segment(recorder().client, target);
    open.text(`\`\`\`\n${'x\n'.repeat(5100)}`);
    expect(open.full).toBe(true);
  });
});

describe('Segment: startStream refused', () => {
  /** startStream refuses with `code` while `refuse` is set; postMessage and update succeed. */
  function refusing(code: string) {
    const calls: string[] = [];
    let refuse = true;
    const ok = (m: string) => async () => (calls.push(m), { ok: true, ts: '1.1' });
    const client = {
      chat: {
        startStream: async () => {
          calls.push('startStream');
          if (refuse) throw Object.assign(new Error(code), { data: { error: code } });
          return { ok: true, ts: '1.1' };
        },
        appendStream: ok('appendStream'),
        stopStream: ok('stopStream'),
        postMessage: ok('postMessage'),
        update: ok('update'),
      },
    } as unknown as WebClient;
    return { calls, client, allow: () => (refuse = false) };
  }

  it('falls back for that message only: the next one streams again (a turn sent over the API)', async () => {
    const { client, calls, allow } = refusing('invalid_arguments');
    const first = new Segment(client, target);
    first.text('From opc.');
    await first.close();
    expect(calls.slice(0, 2)).toEqual(['startStream', 'postMessage']);
    allow();
    calls.length = 0;
    const next = new Segment(client, target);
    next.text('From Slack.');
    await next.close();
    expect(calls[0]).toBe('startStream');
    expect(calls).not.toContain('postMessage');
  });

  it('a refusal that holds for every message turns streaming off for the runner', async () => {
    const { client, calls, allow } = refusing('missing_scope');
    const first = new Segment(client, target);
    first.text('A.');
    await first.close();
    allow();
    calls.length = 0;
    const next = new Segment(client, target);
    next.text('B.');
    await next.close();
    expect(calls[0]).toBe('postMessage');
    expect(calls).not.toContain('startStream');
  });
});
