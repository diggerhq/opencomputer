import { describe, expect, it } from 'vitest';
import type { HostToGateway } from '../protocol.js';
import type { Cloudflared } from './cloudflared.js';
import { hostPreviews } from './previews.js';

const tunnel = (): Cloudflared & { tokens: (string | undefined)[] } => {
  const tokens: (string | undefined)[] = [];
  return { tokens, set: (t) => tokens.push(t), stop: () => tokens.push('stopped'), running: false };
};

describe('host previews', () => {
  it('asks the gateway, probes the port with the URL\'s host, and answers the runner', async () => {
    const asked: HostToGateway[] = [];
    const probed: [number, string][] = [];
    const p = hostPreviews({
      ask: (m) => {
        asked.push(m);
        queueMicrotask(() => p.answer({ id: m.id, result: { url: 'https://demo.opencomputer.app', name: 'demo', port: 5173 } }));
        return true;
      },
      tunnel: tunnel(),
      probe: async (port, host) => (probed.push([port, host]), { listening: true }),
    });
    const a = await p.request('C1:1.2', { t: 'preview', id: 'r1', req: { port: 5173 } });
    expect(asked).toMatchObject([{ t: 'preview', from: 'C1:1.2', req: { port: 5173 } }]);
    expect(probed).toEqual([[5173, 'demo.opencomputer.app']]);
    expect(a).toEqual({ t: 'previewed', id: 'r1', result: { url: 'https://demo.opencomputer.app', name: 'demo', port: 5173, listening: true } });
  });

  it('passes the gateway\'s sentence back as the error, and fails fast without a gateway', async () => {
    const p = hostPreviews({
      ask: (m) => (queueMicrotask(() => p.answer({ id: m.id, error: 'demo is taken; try demo-2' })), true),
      tunnel: tunnel(),
      probe: async () => ({ listening: true }),
    });
    expect(await p.request('k', { t: 'unpreview', id: 'r2', req: { name: 'demo' } })).toEqual({ t: 'previewed', id: 'r2', error: 'demo is taken; try demo-2' });
    const offline = hostPreviews({ ask: () => false, tunnel: tunnel() });
    expect(await offline.request('k', { t: 'preview', id: 'r3', req: { port: 1 } })).toEqual({ t: 'previewed', id: 'r3', error: 'gateway not connected' });
  });

  it('runs the tunnel from the config\'s token and stops it without one', async () => {
    const t = tunnel();
    const p = hostPreviews({ ask: () => false, tunnel: t, proxyPort: 0 });
    p.configure({ tunnelToken: 'tok', key: 'k', ports: [] });
    p.configure(undefined);
    p.stop();
    expect(t.tokens).toEqual(['tok', undefined, 'stopped']);
  });
});
