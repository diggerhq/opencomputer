import { describe, expect, it } from 'vitest';
import type { RunnerToHost, SessionReport } from '../protocol.js';
import { adoption } from './adoption.js';

const report = (forkPath: string): RunnerToHost => ({ t: 'report', report: { key: 'k', status: 'idle', forkPath } as SessionReport });
const telemetry = { t: 'telemetry', batch: {} } as RunnerToHost;

function setup(verify: boolean, complete = (p?: string) => p === '/done', timeoutMs = 1000) {
  const log: string[] = [];
  const a = adoption({ verify, complete, timeoutMs, take: (m) => log.push(m ? `take ${m.t}` : 'take'), stop: (why) => log.push(`stop: ${why}`),
    gone: () => log.push('gone') });
  return { a, log };
}

describe('adoption', () => {
  it('a cold start (no verify) takes the runner on at once', () => {
    const { a, log } = setup(false);
    expect(log).toEqual(['take']);
    expect(a.message(report('/anything'))).toBe(true);
  });

  it('a running runner in a complete fork is taken on at its first report, which the host then handles', () => {
    const { a, log } = setup(true);
    expect(a.message(telemetry)).toBe(true);
    expect(log).toEqual([]);
    expect(a.message(report('/done'))).toBe(true);
    expect(log).toEqual(['take report']);
    expect(a.state).toBe('taken');
  });

  it('a running spare (work 069) is taken on at its first `spare` message', () => {
    const { a, log } = setup(true);
    expect(a.message({ t: 'spare', spare: { id: 'r1', ready: true, version: 'v' } })).toBe(true);
    expect(log).toEqual(['take spare']);
  });

  it('a running runner in an incomplete fork (host died mid-fork) is stopped, never taken on', async () => {
    const { a, log } = setup(true, undefined, 5);
    expect(a.message(report('/partial'))).toBe(false);
    expect(a.message(report('/partial'))).toBe(false); // its `stopped` report
    a.closed();
    await new Promise((r) => setTimeout(r, 20)); // past the timeout
    expect(log).toEqual(['stop: its fork /partial is incomplete']);
    expect(a.state).toBe('stopped');
  });

  it('a runner that never reports is stopped after the timeout (its socket does not name its session); one that closes first is gone', async () => {
    const silent = setup(true, undefined, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(silent.log).toEqual(['stop: it did not report within the adoption timeout']);
    const closing = setup(true, undefined, 5);
    closing.a.closed();
    await new Promise((r) => setTimeout(r, 20));
    expect(closing.log).toEqual(['gone']);
  });
});
