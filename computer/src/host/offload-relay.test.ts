import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { askLine } from '../offload-protocol.js';
import { loadHostConfig } from './host-config.js';
import { offloadRelay } from './offload-relay.js';

function setup(ready: boolean | 'down') {
  const run = mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  mkdirSync(path.join(run, 'tokens'));
  const asked: Record<string, unknown>[] = [];
  const ask = (async (_c: string, req: Record<string, unknown>) => {
    asked.push(req);
    if (ready === 'down') throw new Error('connect ENOENT');
    return req.op === 'health' ? { ok: true, ready, reason: ready ? undefined : 'offload is draining on this host' } : { ok: true, echoed: req };
  }) as unknown as typeof askLine;
  const relay = offloadRelay({ control: '/run/opencomputer-offload/control.sock', org: () => 'org-1', ask, now: () => 5 });
  return { run, relay, asked };
}
const listening = (socket: string) => new Promise<void>((r) => { const t = setInterval(() => existsSync(socket) && (clearInterval(t), r()), 5); });

describe('offload relay', () => {
  it('is off unless SP_OFFLOAD_CONTROL is set', () => {
    expect(loadHostConfig({}, 8 * 2 ** 30, 'linux').config.offloadSocket).toBeUndefined();
    expect(loadHostConfig({ SP_OFFLOAD_CONTROL: '/run/c.sock' }, 8 * 2 ** 30, 'linux').config.offloadSocket).toBe('/run/c.sock');
  });
  it('serves no socket while the service is down or not ready', async () => {
    for (const state of ['down', false] as const) {
      const { run, relay } = setup(state);
      expect(await relay.refresh()).toBe(false);
      expect(relay.serveRunner(run, 'a', () => 'C1:1.1')).toBeUndefined();
      expect(existsSync(path.join(run, 'tokens', 'a.offload.sock'))).toBe(false);
    }
  });
  it('attaches the host\'s fence, drops the session\'s, offers only session ops, and cancels the fence on close', async () => {
    const { run, relay, asked } = setup(true);
    await relay.refresh();
    const h = relay.serveRunner(run, 'a', () => 'C1:1.1')!;
    expect(h.socket).toBe(path.join(run, 'tokens', 'a.offload.sock'));
    expect(relay.serveRunner(run, 'a', () => 'C1:1.1')).toBe(h);
    await listening(h.socket);
    const r = (await askLine(h.socket, { op: 'status', id: 'j1', fence: { org: 'evil', sessionKey: 'C9:9.9', runnerId: 'x', epoch: 1e15 } })) as unknown as { echoed: Record<string, unknown> };
    expect(r.echoed).toEqual({ op: 'status', id: 'j1', fence: { org: 'org-1', sessionKey: 'C1:1.1', runnerId: 'a', epoch: 5 } });
    for (const op of ['cancelFence', 'drain', 'nope']) expect(await askLine(h.socket, { op })).toMatchObject({ ok: false, code: 'refused' });
    h.close();
    expect(existsSync(h.socket)).toBe(false);
    expect(asked.at(-1)).toEqual({ op: 'cancelFence', fence: { org: 'org-1', sessionKey: 'C1:1.1', runnerId: 'a', epoch: 5 } });
  });
  it('refuses a spare (no thread), and every socket gets a larger epoch', async () => {
    const { run, relay, asked } = setup(true);
    await relay.refresh();
    const spare = relay.serveRunner(run, 'sp', () => { throw new Error('this runner serves no thread'); })!;
    await listening(spare.socket);
    expect(await askLine(spare.socket, { op: 'list' })).toMatchObject({ ok: false, code: 'refused' });
    const b = relay.serveRunner(run, 'b', () => 'C1:1.1')!;
    await listening(b.socket);
    await askLine(b.socket, { op: 'list' });
    expect((asked.at(-1)!.fence as { epoch: number }).epoch).toBe(6);
    spare.close();
    b.close();
  });
});
