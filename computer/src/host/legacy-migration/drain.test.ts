// ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11.

import type net from 'node:net';
import { describe, expect, it } from 'vitest';
import type { HostToRunner } from '../../protocol.js';
import { legacyDrain } from './drain.js';

function rig(ids: string[]) {
  let t = 0;
  const live = new Map(ids.map((id) => [id, { id, sock: { id } as unknown as net.Socket }]));
  const sent: string[] = [];
  let exits = 0;
  let ticks = 0;
  const drain = legacyDrain({
    runners: () => live.values(),
    send: (sock, m: HostToRunner) => void sent.push(`${(sock as unknown as { id: string }).id} ${JSON.stringify(m)}`),
    exit: () => void exits++,
    deadlineMs: 600_000, graceMs: 10_000, now: () => t,
    setInterval: () => void ticks++,
  });
  return { drain, live, sent, exits: () => exits, ticks: () => ticks, at: (ms: number) => ((t = ms), drain.tick()) };
}

describe('legacy drain', () => {
  it('tells every runner to exit after its turn, once, and exits when none is left', () => {
    const r = rig(['a', 'spare']);
    expect(r.drain.draining).toBe(false);
    r.drain.start();
    expect(r.drain.draining).toBe(true);
    expect(r.sent).toEqual(['a {"t":"exit"}', 'spare {"t":"exit"}']);
    r.live.delete('spare');
    r.at(1000);
    expect(r.sent).toHaveLength(2);
    expect(r.exits()).toBe(0);
    r.live.delete('a');
    r.at(2000);
    expect(r.exits()).toBe(1);
    r.at(3000);
    expect(r.exits()).toBe(1);
  });

  it('tells a runner that connects later too', () => {
    const r = rig(['a']);
    r.drain.start();
    r.live.set('b', { id: 'b', sock: { id: 'b' } as unknown as net.Socket });
    r.at(1000);
    expect(r.sent).toEqual(['a {"t":"exit"}', 'b {"t":"exit"}']);
  });

  it('holds every delivery: the promise never settles', async () => {
    const r = rig(['a']);
    r.drain.start();
    const settled = await Promise.race([r.drain.held().then(() => 'settled', () => 'settled'), new Promise((ok) => setTimeout(() => ok('held'), 20))]);
    expect(settled).toBe('held');
  });

  it('at the deadline tells the rest to go now, and leaves after the grace whatever is left', () => {
    const r = rig(['busy']);
    r.drain.start();
    r.at(599_999);
    expect(r.sent).toEqual(['busy {"t":"exit"}']);
    r.at(600_000);
    expect(r.sent).toEqual(['busy {"t":"exit"}', 'busy {"t":"exit","ms":0}']);
    r.at(605_000);
    expect(r.sent).toHaveLength(2);
    expect(r.exits()).toBe(0);
    r.at(610_000);
    expect(r.exits()).toBe(1);
  });

  it('a host with no runner exits at once; a second start is nothing', () => {
    const r = rig([]);
    r.drain.start();
    r.drain.start();
    expect(r.exits()).toBe(1);
    expect(r.ticks()).toBe(0);
  });
});
