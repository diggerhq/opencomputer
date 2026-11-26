import { describe, expect, it } from 'vitest';
import { meteredClient, placeholderWrites, queuedSince, type SurfaceCall } from './surface-meter.js';

const failing = (error: string) => ({ reactions: { remove: async () => Promise.reject({ data: { error } }) } });

describe('meteredClient', () => {
  it('counts a call whose target state already holds as successful', async () => {
    const seen: SurfaceCall[] = [];
    const c = meteredClient(failing('no_reaction'), (x) => seen.push(x));
    await expect(c.reactions.remove()).rejects.toBeTruthy();
    expect(seen).toEqual([{ method: 'reactions.remove', ms: expect.any(Number), ok: true }]);
  });

  it('reports other errors as failures', async () => {
    const seen: SurfaceCall[] = [];
    const c = meteredClient(failing('channel_not_found'), (x) => seen.push(x));
    await expect(c.reactions.remove()).rejects.toBeTruthy();
    expect(seen[0]).toMatchObject({ method: 'reactions.remove', ok: false, error: 'channel_not_found' });
  });

  it("marks a write of only the turn's opening card, without reading its arguments", async () => {
    const seen: SurfaceCall[] = [];
    const c = meteredClient({ chat: { startStream: async (_a: object) => ({ ok: true }) } }, (x) => seen.push(x));
    const opening = { channel: 'C1' };
    placeholderWrites.add(opening);
    await c.chat.startStream(opening);
    await c.chat.startStream({ channel: 'C1' });
    expect(seen.map((x) => x.placeholder)).toEqual([true, undefined]);
  });

  it('reports how long a stamped write waited before it was sent', async () => {
    const seen: SurfaceCall[] = [];
    const c = meteredClient({ chat: { appendStream: async (_a: object) => ({ ok: true }) } }, (x) => seen.push(x));
    const waited = { channel: 'C1' };
    queuedSince.set(waited, performance.now() - 250);
    await c.chat.appendStream(waited);
    await c.chat.appendStream({ channel: 'C1' });
    expect(seen[0].queuedMs).toBeGreaterThanOrEqual(250);
    expect(seen[0].queuedMs).toBeLessThan(1000);
    expect(seen[1].queuedMs).toBeUndefined();
  });
});
