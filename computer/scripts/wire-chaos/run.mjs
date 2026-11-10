#!/usr/bin/env node
// The relay's P1b chaos and security checks (work 084), as runnable checks.
// Locally each one starts the real relay (src/wire/relay.ts) in this process
// against a fake host wire socket and a fake writer socket (src/wire/test-fakes.ts),
// does the damage, and checks what a client sees. They need nothing but node.
//
//   node scripts/wire-chaos/run.mjs            run every local check
//   node scripts/wire-chaos/run.mjs <name>…    run some (names below)
//   node scripts/wire-chaos/run.mjs --staging  print the checks that need staging, and how
//
// Local: forged-signature, no-subprotocol, oversize-frame, rate-limit,
// path-traversal, host-link-drop, relay-restart, slow-reader.
//
// Staging only (printed by --staging; not automated here): what needs the real
// Worker, KV, tunnel, systemd unit, users and kernel. They are steps for a
// person on a staging computer, each with the outcome to expect.
//
// Invariants: every server a check starts is closed before the next check; a
// check prints PASS or FAIL with what it saw, and the exit code is the count
// of failures (0 when all pass).

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { register } from 'tsx/esm/api';

register();
const ROOT = path.resolve(import.meta.dirname, '../..');
const { startRelay } = await import(path.join(ROOT, 'src/wire/relay.ts'));
const F = await import(path.join(ROOT, 'src/wire/test-fakes.ts'));
const { signWire } = await import(path.join(ROOT, 'src/signed-header.ts'));

const STAGING = [
  ['credential at the edge', 'opc with a revoked key, then an unknown one, then none', 'refused at the Worker (an accepted upgrade closed with the code); nothing reaches the computer (relay log quiet)'],
  ['revocation bound', 'revoke a key with a connection open', 'the open connection closes with 4001 within seconds (host push); new upgrades refused within 60 s (KV)'],
  ['signature from outside', 'curl the tunnel hostname with hand-made X-Wire-* headers, bypassing the Worker if reachable', '403 from the relay; the Worker overwrites any client X-Wire-* headers'],
  ['tunnel drop', 'systemctl kill -s KILL on cloudflared (child of the host)', 'clients see 1006 or 1001, reconnect when the host restarts cloudflared, reattach with after; no event lost or repeated'],
  ['relay crash under systemd', 'systemctl kill -s KILL slack-presence-wire', 'Restart=always brings it back within ~1 s; clients reconnect; NRestarts goes up by one'],
  ['memory cap', 'drive many slow readers at the relay (or lower MemoryMax in a drop-in)', 'the kernel kills the relay at 256 MiB, never the host or a runner; it restarts; clients reconnect'],
  ['ptrace across users', 'as agent (a session): gdb -p / cat /proc/<relay pid>/mem; as sp-wire: the same on a runner', 'both refused (kernel.yama.ptrace_scope=1 and different users)'],
  ['sp-wire permissions', 'sudo -u sp-wire: read /data, /etc/slack-presence/host.env, sudo -n true, connect anywhere but loopback', 'all refused; wire.sock and runners/*.api.sock connect'],
  ['session cannot reach the relay\'s host socket', 'as agent: socat - UNIX:/run/slack-presence/wire/wire.sock', 'permission denied (0660 <host>:sp-wire)'],
];

let failures = 0;
const report = (name, ok, saw) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${saw}`);
};

/** A unix socket in front of the fake host, so a check can cut the host link and bring it back at the same path. */
async function hostProxy(target) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wire-chaos-'));
  const socket = path.join(dir, 'wire.sock');
  const pipes = new Set();
  let server;
  const up = () =>
    new Promise((r) => {
      server = net.createServer((a) => {
        const b = net.connect(target);
        for (const s of [a, b]) {
          s.on('error', () => {});
          pipes.add(s);
          s.on('close', () => pipes.delete(s));
        }
        a.pipe(b).pipe(a);
      });
      server.listen(socket, r);
    });
  const down = () =>
    new Promise((r) => {
      for (const s of pipes) s.destroy();
      server.close(() => r());
    });
  await up();
  return { socket, up, down, close: async () => (await down(), rmSync(dir, { recursive: true, force: true })) };
}

/** The relay, a fake host behind a proxy, a fake writer socket, and one session the member may attach to. */
async function rig(o = {}) {
  const session = F.sid();
  const writer = await F.fakeWriterSocket();
  const host = await F.fakeHost({
    access: [F.accessFor(session)],
    answer: (m) => (m.t === 'where' ? { result: { socket: writer.socket, token: 'tok', writer: 'host', epoch: 1 } } : undefined),
  });
  const proxy = await hostProxy(host.socket);
  const opts = { host: '127.0.0.1', port: o.port ?? 0, socket: proxy.socket, version: 'chaos', region: null, telemetryMs: 3_600_000 };
  const r = { session, writer, host, proxy, opts, relay: await startRelay(opts) };
  await F.until(() => r.relay.hostLink.key !== null);
  r.close = async () => {
    await r.relay.close();
    await proxy.close();
    await writer.close();
    await host.close();
  };
  return r;
}

const health = (port) =>
  new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => (res.resume(), resolve(res.statusCode))).on('error', () => resolve(0));
  });
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no ${what} within ${ms} ms`)), ms))]);

const CHECKS = {
  async 'forged-signature'(r) {
    const c = F.connectClient(r.relay.port, { key: 'not-the-edge-key' });
    const status = await new Promise((resolve) => {
      c.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      c.ws.on('open', () => resolve('upgraded'));
    });
    const now = Date.now();
    const stale = signWire(F.KEY, { member: 'usr_owner', keyId: 'ak_000000000000', client: 'opc/0.1.0', scope: {} }, now - 3_600_000);
    const res = await new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port: r.relay.port, path: `/files/${r.session}/file?path=a`, headers: stale }, (x) => (x.resume(), resolve(x.statusCode)));
      q.on('error', () => resolve(0));
      q.end();
    });
    report('forged-signature', status === 403 && res === 403, `wrong key upgrade → ${status}; an hour-old signature on /files → ${res}`);
  },
  async 'no-subprotocol'(r) {
    const c = F.connectClient(r.relay.port, { protocol: 'opc.v0' });
    const { code } = await within(c.closed, 3000, 'close');
    report('no-subprotocol', code === 4400, `offering opc.v0 → close ${code}`);
  },
  async 'oversize-frame'(r) {
    const c = F.connectClient(r.relay.port);
    await c.next((m) => m.method === 'ready');
    c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sessions.list', params: { pad: 'x'.repeat(1024 * 1024 + 10) } }));
    const { code } = await within(c.closed, 3000, 'close');
    report('oversize-frame', code === 1009, `a 1 MiB + 10 B message → close ${code}`);
  },
  async 'rate-limit'(r) {
    const c = F.connectClient(r.relay.port);
    await c.next((m) => m.method === 'ready');
    for (let i = 1; i <= 150; i++) c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1000 + i, method: 'sessions.detach', params: { sessionId: r.session } }));
    await F.until(() => c.frames.filter((m) => m.id > 1000).length >= 150, 5000).catch(() => {});
    const limited = c.frames.filter((m) => m.error?.data?.code === 'rate_limited').length;
    report('rate-limit', limited >= 40 && c.ws.readyState === 1, `150 requests at once → ${limited} rate_limited, connection ${c.ws.readyState === 1 ? 'open' : 'closed'}`);
    c.ws.close();
  },
  async 'path-traversal'(r) {
    const before = r.host.calls.length;
    const headers = signWire(F.KEY, { member: 'usr_owner', keyId: 'ak_000000000000', client: 'opc/0.1.0', scope: {} });
    const paths = ['../etc/passwd', '..', '/etc/passwd', 'a/../../b', 'a%00b', '%2e%2e/x', './../x'];
    const codes = [];
    for (const p of paths) {
      codes.push(
        await new Promise((resolve) => {
          const q = http.request({ host: '127.0.0.1', port: r.relay.port, path: `/files/${r.session}/file?path=${p}`, headers }, (x) => {
            let b = '';
            x.on('data', (d) => (b += d));
            x.on('end', () => resolve(`${x.statusCode}:${b.match(/"code":"([a-z_]+)"/)?.[1]}`));
          });
          q.on('error', () => resolve('error'));
          q.end();
        }),
      );
    }
    const ok = codes.every((c) => c === '400:invalid_path') && r.host.calls.length === before;
    report('path-traversal', ok, `${paths.length} escaping paths → ${[...new Set(codes)].join(', ')}; host asked ${r.host.calls.length - before} times`);
  },
  async 'host-link-drop'(r) {
    const open = F.connectClient(r.relay.port, { query: `attach=${r.session}&after=0` });
    await open.next((m) => m.method === 'sessions.attached');
    await r.proxy.down();
    await F.until(() => !r.relay.hostLink.connected, 3000);
    const during = await health(r.relay.port);
    // The relay keeps the last edge key through a host blip (host-link.ts), so a new client still
    // connects; what it cannot do until the host is back is reach a writer.
    const late = F.connectClient(r.relay.port);
    const ready = await late.next((m) => m.method === 'ready', 3000).then(() => true, () => false);
    await r.proxy.up();
    await F.until(() => r.relay.hostLink.connected && r.relay.hostLink.key !== null, 10_000);
    const after = await health(r.relay.port);
    const fresh = F.connectClient(r.relay.port, { query: `attach=${r.session}&after=0` });
    const attached = await fresh.next((m) => m.method === 'sessions.attached', 5000).then(() => true, () => false);
    const stillOpen = open.ws.readyState === 1;
    report(
      'host-link-drop',
      during === 503 && ready && after === 200 && attached && stillOpen,
      `host gone: /health ${during}, a new client ${ready ? 'got ready' : 'got nothing'}; back: /health ${after}, attach ${attached ? 'works' : 'fails'}; the attached client stayed ${stillOpen ? 'open' : 'closed'}`,
    );
    for (const c of [open, late, fresh]) c.ws.close();
  },
  async 'relay-restart'(r) {
    const c = F.connectClient(r.relay.port, { query: `attach=${r.session}&after=0` });
    await c.next((m) => m.method === 'sessions.attached');
    await F.until(() => r.writer.subscribed);
    r.writer.emit(F.event(r.session, 1));
    await c.next((m) => m.params?.seq === 1);
    const port = r.relay.port;
    await r.relay.close(1012);
    const { code } = await within(c.closed, 3000, 'close');
    r.relay = await startRelay({ ...r.opts, port });
    await F.until(() => r.relay.hostLink.key !== null);
    const again = F.connectClient(port, { query: `attach=${r.session}&after=1` });
    await again.next((m) => m.method === 'sessions.attached');
    await F.until(() => r.writer.subscribed);
    for (const seq of [1, 2]) r.writer.emit(F.event(r.session, seq));
    await again.next((m) => m.params?.seq === 2);
    await new Promise((s) => setTimeout(s, 100));
    const dup = again.frames.some((m) => m.params?.seq === 1);
    report('relay-restart', code === 1012 && !dup, `clients closed with ${code}; reconnect with after=1 got seq 2${dup ? ' and a repeat of seq 1' : ', no repeat'}`);
    again.ws.close();
  },
  async 'slow-reader'(r) {
    const c = F.connectClient(r.relay.port, { query: `attach=${r.session}&after=0` });
    await c.next((m) => m.method === 'sessions.attached');
    await F.until(() => r.writer.subscribed);
    c.ws._socket.pause();
    const rss0 = process.memoryUsage().rss;
    const data = { text: 'y'.repeat(64 * 1024) };
    const N = 600; // ~38 MiB of events
    for (let seq = 1; seq <= N; seq++) r.writer.emit(F.event(r.session, seq, 'message.completed', data));
    await new Promise((s) => setTimeout(s, 1500));
    const grew = (process.memoryUsage().rss - rss0) / 2 ** 20;
    c.ws._socket.resume();
    const outcome = await within(
      Promise.race([
        c.closed.then((x) => `closed ${x.code}`),
        c.next((m) => m.method === 'session.detached', 20_000).then((m) => `detached ${m.params.reason}`),
        c.next((m) => m.params?.seq === N, 20_000).then(() => 'caught up'),
      ]),
      25_000,
      'outcome',
    ).catch((e) => e.message);
    const seqs = c.frames.filter((m) => typeof m.params?.seq === 'number').map((m) => m.params.seq);
    const ordered = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
    const ok = ordered && ['closed 4008', 'detached too_far_behind', 'caught up'].includes(outcome) && grew < 256;
    report('slow-reader', ok, `a reader that stopped for ${N} × 64 KiB: ${outcome}; events it got in order and gapless: ${ordered}; process RSS grew ${grew.toFixed(0)} MiB, the fake writer's own unsent buffer and the events' strings included (must stay under the unit's 256 MiB; the real number is the staging memory-cap check)`);
    c.ws.close();
  },
};

if (process.argv.includes('--staging')) {
  console.log('Checks that need a staging computer (the real Worker, KV, tunnel, systemd unit, users, kernel):\n');
  for (const [name, how, expect] of STAGING) console.log(`- ${name}\n    do:     ${how}\n    expect: ${expect}\n`);
  process.exit(0);
}

const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const name of names.length ? names : Object.keys(CHECKS)) {
  const check = CHECKS[name];
  if (!check) {
    report(name, false, `no such check (have: ${Object.keys(CHECKS).join(', ')})`);
    continue;
  }
  const r = await rig();
  try {
    await within(check(r), 60_000, 'result');
  } catch (e) {
    report(name, false, e.message);
  } finally {
    await r.close().catch(() => {});
  }
}
console.log(`\n${failures ? `${failures} failed` : 'all passed'}; ${STAGING.length} more need staging (--staging lists them)`);
process.exit(failures);
