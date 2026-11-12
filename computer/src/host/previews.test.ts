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
      // A gateway gives each thread a name of its own.
      const { p, asked, probed, ports } = rig((m) => (m.t === 'preview' && m.from !== 'C1:1.2' ? { result: { url: 'https://other.opencomputer.app', name: 'other', port: m.req.port } } : named(m)));
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

    it('unpreview: only a name of the caller\'s own sandbox; for any other the gateway is not asked and nothing is freed', async () => {
      const { p, asked, ports } = rig(named);
      await p.request('C1:1.2', { t: 'preview', id: 'r1', req: { port: 5173 } }, 'aaaa');
      expect(await p.request('C1:3.4', { t: 'unpreview', id: 'r2', req: { name: 'demo' } }, 'bbbb')).toEqual({ t: 'previewed', id: 'r2', error: 'no preview named demo in this session' });
      expect(await p.request('C1:3.4', { t: 'unpreview', id: 'r3', req: { name: 'never' } }, 'bbbb')).toEqual({ t: 'previewed', id: 'r3', error: 'no preview named never in this session' });
      expect(asked.map((m) => m.t)).toEqual(['preview']);
      expect(ports.all()).toHaveLength(1);
    });

    it('forget: a removed sandbox\'s name is unpreviewed at the gateway by the host itself, and a gateway that is away fails nothing', async () => {
      const { p, asked, ports } = rig(named);
      p.forget('demo', 'C1:1.2');
      expect(asked).toMatchObject([{ t: 'unpreview', from: 'C1:1.2', req: { name: 'demo' } }]);
      await new Promise((r) => setImmediate(r));
      expect(ports.owed()).toEqual([]);
      const away = hostPreviews({ ask: () => false, tunnel: tunnel() });
      expect(() => away.forget('demo', '')).not.toThrow();
      await new Promise((r) => setImmediate(r));
    });

    it('forget with the gateway away: the name is owed, on disk, and asked again each time the gateway is back until it answers', async () => {
      const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'sp-previews-')), 'previews.json');
      const asked: HostToGateway[] = [];
      let there = false;
      let answer: { result?: { url: string; name: string; port: number }; error?: string } = { result: { url: '', name: 'demo', port: 0 } };
      const make = () => {
        const ports = previewPorts(file);
        const p = hostPreviews({ ask: (m) => there && (asked.push(m), queueMicrotask(() => p.answer({ id: m.id, ...answer })), true), tunnel: tunnel(), sandbox: { ports, run: (id) => `/run/x/sandbox/${id}` } });
        return { p, ports };
      };
      const a = make();
      a.p.forget('demo', 'C1:1.2');
      a.p.forget('shop', '');
      await new Promise((r) => setImmediate(r));
      expect(a.ports.owed()).toEqual([{ name: 'demo', from: 'C1:1.2' }, { name: 'shop', from: '' }]);
      // A host restart keeps what is owed; the gateway's welcome sends it.
      const b = make();
      expect(b.ports.owed()).toHaveLength(2);
      there = true;
      b.p.connected();
      b.p.connected(); // a second welcome while the first is unanswered asks nothing twice
      expect(asked).toMatchObject([{ t: 'unpreview', from: 'C1:1.2', req: { name: 'demo' } }, { t: 'unpreview', from: '', req: { name: 'shop' } }]);
      await new Promise((r) => setImmediate(r));
      expect(b.ports.owed()).toEqual([]);
      b.p.connected();
      expect(asked).toHaveLength(2);
      // A gateway that heard and said no is not asked again: its answer would be the same.
      answer = { error: 'no preview named gone' };
      b.p.forget('gone', '');
      await new Promise((r) => setImmediate(r));
      expect(b.ports.owed()).toEqual([]);
    });

    it('a name that is owed and is given to a preview again is not owed any more: the retry would take it from its new session', async () => {
      const { p, ports } = rig(named);
      ports.owe('demo', 'C1:1.2');
      await p.request('C1:3.4', { t: 'preview', id: 'r1', req: { port: 5173 } }, 'bbbb');
      expect(ports.owed()).toEqual([]);
    });

    it('preview: a name another sandbox holds, or is being given, is refused before the gateway is asked; its own name it may ask for again', async () => {
      const { p, asked, ports } = rig((m) => (m.t === 'preview' ? { result: { url: `https://${m.req.name ?? 'demo'}.opencomputer.app`, name: m.req.name ?? 'demo', port: m.req.port } } : { result: { url: '', name: 'demo', port: 0 } }));
      await p.request('C1:1.2', { t: 'preview', id: 'r1', req: { port: 5173 } }, 'aaaa');
      expect(await p.request('C1:3.4', { t: 'preview', id: 'r2', req: { port: 3000, name: 'demo' } }, 'bbbb')).toEqual({ t: 'previewed', id: 'r2', error: 'another session has a preview named demo; choose another name' });
      expect(asked).toHaveLength(1);
      expect(ports.all()).toEqual([{ virtual: 30000, id: 'aaaa', port: 5173, name: 'demo' }]);
      // Two sessions ask for one free name at once: the first to ask has it, whatever order the gateway would answer in.
      const [a, b] = await Promise.all([
        p.request('C1:1.2', { t: 'preview', id: 'r3', req: { port: 8000, name: 'shop' } }, 'aaaa'),
        p.request('C1:3.4', { t: 'preview', id: 'r4', req: { port: 8000, name: 'shop' } }, 'bbbb'),
      ]);
      expect(a).toMatchObject({ result: { name: 'shop' } });
      expect(b).toEqual({ t: 'previewed', id: 'r4', error: 'another session has a preview named shop; choose another name' });
      expect(asked).toHaveLength(2);
      // Its own name, on another port: the gateway is asked, and the name is the new port's alone.
      expect(await p.request('C1:1.2', { t: 'preview', id: 'r5', req: { port: 9000, name: 'demo' } }, 'aaaa')).toMatchObject({ result: { name: 'demo', port: 9000 } });
      expect(ports.all().filter((e) => e.name === 'demo')).toEqual([{ virtual: 30002, id: 'aaaa', port: 9000, name: 'demo' }]);
      // A request that failed holds no name.
      const refused = rig(() => ({ error: 'no' }));
      await refused.p.request('k', { t: 'preview', id: 'r1', req: { port: 1, name: 'x' } }, 'aaaa');
      expect(await refused.p.request('k', { t: 'preview', id: 'r2', req: { port: 1, name: 'x' } }, 'bbbb')).toEqual({ t: 'previewed', id: 'r2', error: 'no' });
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
