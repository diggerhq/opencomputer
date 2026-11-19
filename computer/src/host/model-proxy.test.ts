// The control-socket client against the proxy's golden frames
// (computer/modelproxy/testdata/control): what it sends has the shape of
// bind.json, bind-refuse.json, release.json, request.json and synced.json;
// what it reads is the proxy's hello, bound, refused, observed, event and
// response files verbatim. model-access.test.ts runs the real binary.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lines } from '../ipc.js';
import { type ModelProxy, modelProxy, type ProxyHooks } from './model-proxy.js';

const GOLDEN = path.resolve(import.meta.dirname, '../../modelproxy/testdata/control');
const golden = (name: string) => JSON.parse(readFileSync(path.join(GOLDEN, `${name}.json`), 'utf8'));
const keys = (o: object) => Object.keys(o).sort();

/** A fake proxy: a control socket that records frames and lets the test answer. */
function fakeProxy(o: { hello?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const sockPath = path.join(dir, 'control.sock');
  const got: Record<string, unknown>[] = [];
  let conn: net.Socket | undefined;
  let conns = 0;
  const server = net.createServer((c) => {
    conn = c;
    conns++;
    lines(c, (m) => got.push(m));
    if (o.hello !== false) c.write(`${JSON.stringify(golden('hello'))}\n`);
  });
  server.listen(sockPath);
  return {
    sockPath,
    got,
    get conns() {
      return conns;
    },
    say: (m: object) => conn?.write(`${JSON.stringify(m)}\n`),
    drop: () => conn?.destroy(),
    close: () => new Promise<void>((r) => (conn?.destroy(), server.close(() => (rmSync(dir, { recursive: true, force: true }), r())))),
  };
}

const hooks = (): ProxyHooks & { calls: Record<string, unknown[]> } => {
  const calls: Record<string, unknown[]> = { hello: [], changed: [], observed: [], event: [] };
  return {
    calls,
    hello: (h) => calls.hello.push(h),
    changed: (u) => calls.changed.push(u),
    observed: (m) => calls.observed.push(m),
    event: (e) => calls.event.push(e),
  };
};

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function start(o: { hello?: boolean } = {}, opts = {}) {
  const fake = fakeProxy(o);
  const h = hooks();
  const p = modelProxy(fake.sockPath, h, opts);
  cleanup.push(fake.close, () => p.stop());
  return { fake, h, p };
}

const upWithin = (p: ModelProxy, up = true) => vi.waitFor(() => expect(p.up).toBe(up), { timeout: 3000 });

describe('model proxy control client (golden frames)', () => {
  it('reads the hello, keeps it, answers `synced` after the hello hook, and is up', async () => {
    const { fake, h, p } = start();
    await upWithin(p);
    const hello = golden('hello');
    expect(p.hello).toEqual({ version: hello.version, protocol: 1, placeholder: hello.placeholder, profiles: hello.profiles, bindings: hello.bindings });
    expect(h.calls.hello).toHaveLength(1);
    expect(h.calls.changed).toEqual([true]);
    await vi.waitFor(() => expect(fake.got).toEqual([golden('synced')]));
    expect(p.downSince).toBeUndefined();
  });

  it('binds with the shape of bind.json and resolves on bound.json; refused.json resolves its code', async () => {
    const { fake, p } = start();
    await upWithin(p);
    const b = golden('bind');
    const bound = p.bind({ caller: b.caller, sessionKey: b.sessionKey, profile: b.profile, vars: b.vars, key: b.key });
    await vi.waitFor(() => expect(fake.got.length).toBe(2));
    const sent = fake.got[1];
    expect(keys(sent)).toEqual(keys(b));
    expect({ ...sent, id: b.id }).toEqual(b);
    fake.say({ ...golden('bound'), id: sent.id });
    expect(await bound).toEqual({ bound: true, key: 'k1' });

    const r = golden('bind-refuse');
    const refused = p.bind({ caller: r.caller, sessionKey: r.sessionKey, mode: 'refuse', reason: r.reason });
    await vi.waitFor(() => expect(fake.got.length).toBe(3));
    expect(fake.got[2]).toEqual({ ...r, id: fake.got[2].id });
    fake.say({ ...golden('refused'), id: fake.got[2].id });
    expect(await refused).toEqual({ bound: false, code: 'caller_in_use' });
  });

  it('a bind with no answer in time times out and drops the connection; it dials again', async () => {
    const { fake, h, p } = start({}, { bindMs: 100 });
    await upWithin(p);
    expect(await p.bind({ caller: 'c', sessionKey: 's', mode: 'refuse', reason: 'r' })).toEqual({ bound: false, code: 'timeout' });
    await vi.waitFor(() => expect(h.calls.changed).toEqual([true, false, true]), { timeout: 3000 });
    expect(fake.conns).toBe(2);
  });

  it('releases with release.json; relays observed and events unread', async () => {
    const { fake, h, p } = start();
    await upWithin(p);
    p.release('abc123');
    await vi.waitFor(() => expect(fake.got[1]).toEqual(golden('release')));
    for (const name of ['observed', 'observed-error']) fake.say(golden(name));
    for (const name of ['event-request', 'event-binding', 'event-denied', 'event-held', 'event-pool', 'event-proxy-started']) fake.say(golden(name));
    await vi.waitFor(() => expect(h.calls.event).toHaveLength(6));
    const { t: _, ...observed } = golden('observed');
    expect(h.calls.observed[0]).toMatchObject(observed);
    expect((h.calls.event[0] as { name: string }).name).toBe('model.request');
  });

  it('requests with the shape of request.json and resolves on response.json or response-error.json', async () => {
    const { fake, p } = start();
    await upWithin(p);
    const { t: _, ...req } = golden('request');
    const answer = p.request(req);
    await vi.waitFor(() => expect(fake.got[1]).toEqual(golden('request')));
    const { t: _r, ...res } = golden('response');
    fake.say(golden('response'));
    expect(await answer).toEqual(res);
    const failed = p.request(req);
    fake.say(golden('response-error'));
    expect(await failed).toEqual({ id: req.id, error: 'unreachable' });
  });

  it('a request times out after its limit', async () => {
    const { p } = start({}, { requestMs: 50 });
    await upWithin(p);
    expect(await p.request({ id: 'x', profile: 'p', vars: {}, method: 'GET', path: '/' })).toEqual({ id: 'x', error: 'timeout' });
  });

  it('down: no hello within its limit, a close, or no socket at all; binds and requests answer proxy_unavailable', async () => {
    const { fake, p } = start({ hello: false }, { helloMs: 100 });
    await vi.waitFor(() => expect(fake.conns).toBeGreaterThanOrEqual(2), { timeout: 3000 }); // dropped, dialled again
    expect(p.up).toBe(false);
    expect(p.downSince).toBeTypeOf('number');
    expect(await p.bind({ caller: 'c', sessionKey: 's', mode: 'refuse', reason: 'r' })).toEqual({ bound: false, code: 'proxy_unavailable' });
    expect(await p.request({ id: 'x', profile: 'p', vars: {}, method: 'GET', path: '/' })).toEqual({ id: 'x', error: 'proxy_unavailable' });

    const none = modelProxy(undefined, hooks());
    expect(none.up).toBe(false);
    none.stop();
  });

  it('settles pending binds and requests when the connection goes, and says hello again after a redial', async () => {
    const { fake, h, p } = start();
    await upWithin(p);
    const b = p.bind({ caller: 'c', sessionKey: 's', mode: 'refuse', reason: 'r' });
    const r = p.request({ id: 'x', profile: 'p', vars: {}, method: 'GET', path: '/' });
    await vi.waitFor(() => expect(fake.got.length).toBe(3));
    fake.drop();
    expect(await b).toEqual({ bound: false, code: 'proxy_unavailable' });
    expect(await r).toEqual({ id: 'x', error: 'proxy_unavailable' });
    await vi.waitFor(() => expect(h.calls.hello).toHaveLength(2), { timeout: 3000 });
    expect(p.hello?.placeholder).toBe('ssh-placeholder');
  });
});
