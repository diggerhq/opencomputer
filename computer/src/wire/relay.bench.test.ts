// The relay's budget gate (work 084, "Budgets"): relay overhead ≤ 2 ms p99 per
// frame. Measured end to end on loopback, writer socket → the real dialWriter →
// outbox → WebSocket → client, one event in flight at a time, so the number is
// an upper bound on what the relay adds (it includes both sockets' hops).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRelay, type Relay } from './relay.js';
import { accessFor, connectClient, event, fakeHost, fakeWriterSocket, sid, until } from './test-fakes.js';

const session = sid();
let host: Awaited<ReturnType<typeof fakeHost>>;
let writer: Awaited<ReturnType<typeof fakeWriterSocket>>;
let relay: Relay;

beforeAll(async () => {
  writer = await fakeWriterSocket();
  host = await fakeHost({
    access: [accessFor(session)],
    answer: (m) => (m.t === 'where' ? { result: { socket: writer.socket, token: 'tok', writer: 'host', epoch: 1 } } : undefined),
  });
  relay = await startRelay({ host: '127.0.0.1', port: 0, socket: host.socket, version: 'bench', region: null, telemetryMs: 3_600_000 });
  await until(() => relay.hostLink.key !== null);
});
afterAll(async () => {
  await relay.close();
  await writer.close();
  await host.close();
});

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

describe('relay budget', () => {
  it('adds at most 2 ms p99 per frame', async () => {
    const c = connectClient(relay.port, { query: `attach=${session}&after=0` });
    await c.next((m) => m.method === 'sessions.attached');
    await until(() => writer.subscribed);
    const data = { text: 'x'.repeat(200) };
    const samples: number[] = [];
    let waiting: { seq: number; done: (t: number) => void } | undefined;
    c.ws.on('message', (d: Buffer) => {
      const t = performance.now();
      if (waiting && JSON.parse(d.toString()).params?.seq === waiting.seq) waiting.done(t);
    });
    const WARM = 300;
    const N = 3000;
    for (let seq = 1; seq <= WARM + N; seq++) {
      const got = new Promise<number>((done) => (waiting = { seq, done }));
      const t0 = performance.now();
      writer.emit(event(session, seq, 'message.completed', data));
      const t1 = await got;
      if (seq > WARM) samples.push(t1 - t0);
    }
    const p50 = pct(samples, 50);
    const p99 = pct(samples, 99);
    console.log(`relay per-frame latency over ${N} frames: p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${Math.max(...samples).toFixed(3)} ms`);
    expect(p99).toBeLessThanOrEqual(2);
    c.ws.close();
  }, 60_000);
});
