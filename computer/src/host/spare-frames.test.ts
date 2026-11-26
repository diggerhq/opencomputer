import { describe, expect, it } from 'vitest';
import type { RunnerToHost } from '../protocol.js';
import { NO_THREAD, refusal, spareMay } from './spare-frames.js';

describe('a runner that serves no thread', () => {
  it('is heard on its state, its telemetry and its replies only', () => {
    const heard: RunnerToHost['t'][] = ['spare', 'telemetry', 'reply'];
    const all: RunnerToHost['t'][] = ['report', 'spare', 'token', 'spawn', 'read', 'post', 'preview', 'unpreview', 'secret-request', 'checkout', 'telemetry', 'out-of-credits', 'model-denied', 'reply'];
    expect(all.filter((t) => spareMay({ t } as RunnerToHost))).toEqual(heard);
  });

  it('gets each request answered with an error under the request\'s id', () => {
    const answer = (t: string) => refusal({ t, id: 'q' } as RunnerToHost);
    expect(answer('token')).toEqual({ t: 'token', id: 'q', error: NO_THREAD });
    expect(['spawn', 'read', 'post', 'secret-request', 'preview', 'unpreview', 'checkout'].map((t) => answer(t)?.t)).toEqual(['spawned', 'thread', 'posted', 'secret-asked', 'previewed', 'previewed', 'checked-out']);
    expect(refusal({ t: 'out-of-credits' })).toBeUndefined();
    expect(refusal({ t: 'model-denied', model: 'a', fallbackTo: 'b' })).toBeUndefined();
  });
});
