import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostToGateway } from '../protocol.js';
import type { Cloudflared } from './cloudflared.js';
import { hostPreviews } from './previews.js';
import { previewPorts } from './sandbox/preview-ports.js';

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

  describe('on a host whose sessions run in containers', () => {
    const rig = (answer: (m: HostToGateway) => { result?: { url: string; name: string; port: number }; error?: string }) => {
      const asked: HostToGateway[] = [];
      const probed: [number, string][] = [];
      const ports = previewPorts(path.join(mkdtempSync(path.join(os.tmpdir(), 'sp-previews-')), 'previews.json'));
      const p = hostPreviews({
        ask: (m) => (asked.push(m), queueMicrotask(() => p.answer({ id: m.id, ...answer(m) })), true),
        tunnel: tunnel(),
        probe: async (port, host) => (probed.push([port, host]), { listening: true }),
        sandbox: { ports, run: (id) => `/run/x/sandbox/${id}` },
      });
      return { p, asked, probed, ports };
    };
    const named = (m: HostToGateway) => (m.t === 'preview' ? { result: { url: 'https://demo.opencomputer.app', name: 'demo', port: m.req.port } } : { result: { url: '', name: 'demo', port: 0 } });

    it('gives the gateway a virtual port, probes that, and answers the runner with its own', async () => {
      const { p, asked, probed, ports } = rig(named);
      const a = await p.request('C1:1.2', { t: 'preview', id: 'r1', req: { port: 5173 } }, 'aaaa');
      expect(asked).toMatchObject([{ t: 'preview', from: 'C1:1.2', req: { port: 30000 } }]);
      expect(probed).toEqual([[30000, 'demo.opencomputer.app']]);
      expect(a).toEqual({ t: 'previewed', id: 'r1', result: { url: 'https://demo.opencomputer.app', name: 'demo', port: 5173, listening: true } });
      expect(ports.all()).toEqual([{ virtual: 30000, id: 'aaaa', port: 5173, name: 'demo' }]);
      // Another session on the same port has its own number; the same session's port keeps its own.
      await p.request('C1:3.4', { t: 'preview', id: 'r2', req: { port: 5173 } }, 'bbbb');
      await p.request('C1:1.2', { t: 'preview', id: 'r3', req: { port: 5173 } }, 'aaaa');
      expect(asked.map((m) => m.t === 'preview' && m.req.port)).toEqual([30000, 30001, 30000]);
    });

    it('frees the number the gateway refused, and the one whose name is unpreviewed', async () => {
      let refuse = true;
      const { p, ports } = rig((m) => (refuse ? { error: 'demo is taken; try demo-2' } : named(m)));
      expect(await p.request('k', { t: 'preview', id: 'r1', req: { port: 3000, name: 'demo' } }, 'aaaa')).toEqual({ t: 'previewed', id: 'r1', error: 'demo is taken; try demo-2' });
      expect(ports.all()).toEqual([]);
      refuse = false;
      await p.request('k', { t: 'preview', id: 'r2', req: { port: 3000 } }, 'aaaa');
      expect(ports.all()).toHaveLength(1);
      expect(await p.request('k', { t: 'unpreview', id: 'r3', req: { name: 'demo' } }, 'aaaa')).toMatchObject({ result: { listening: false } });
      expect(ports.all()).toEqual([]);
    });

    it('a session that has as many previews as it may is told so, and the gateway is not asked', async () => {
      const { p, asked, ports } = rig(named);
      for (let n = 0; n < 32; n++) ports.assign('aaaa', 4000 + n);
      expect(await p.request('k', { t: 'preview', id: 'r1', req: { port: 5173 } }, 'aaaa')).toEqual({ t: 'previewed', id: 'r1', error: 'this session has 32 previews, the most it can have; unpreview one first' });
      expect(asked).toEqual([]);
      expect(await p.request('k', { t: 'preview', id: 'r2', req: { port: 5173 } }, 'bbbb')).toMatchObject({ result: { port: 5173 } });
    });

    it('never previews a port of the host: a request that names no sandbox is refused before the gateway hears of it', async () => {
      const { p, asked } = rig(named);
      expect(await p.request('k', { t: 'preview', id: 'r1', req: { port: 22 } })).toEqual({ t: 'previewed', id: 'r1', error: 'this computer previews only sessions that run in a container' });
      expect(asked).toEqual([]);
    });
  });
});
