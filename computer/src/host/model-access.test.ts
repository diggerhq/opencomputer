import net from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GatewayToHost, HostCredentials, HostToGateway, HostToRunner } from '../protocol.js';
import type { Telemetry } from '../telemetry/emitter.js';
import { type HostModelAccessDeps, noHostModelAccess } from './model-access.js';
import { createHostModelAccess } from './model-access-impl.js';

const tm = { emit() {} } as unknown as Telemetry;
const creds: HostCredentials = { slackBotToken: 'xoxb', slackBotUserId: 'B', claudeOAuthToken: 'org', anthropicApiKey: 'k', anthropicBaseUrl: 'https://x' };
const slackOnly = { slackBotToken: 'xoxb', slackBotUserId: 'B' };

/** A runner's end as the host sees it: a socket whose writes are kept as parsed messages. */
function runner(harness?: 'codex') {
  const sent: HostToRunner[] = [];
  const sock = new net.Socket();
  Object.assign(sock, { writable: true, write: (d: string) => (sent.push(JSON.parse(d)), true) });
  return { sock, sent, report: undefined, harness };
}

function deps(live?: ReturnType<typeof runner>) {
  const frames: HostToGateway[] = [];
  const d: HostModelAccessDeps = { dataDir: mkdtempSync(path.join(os.tmpdir(), 'ma-')), toGateway: (m) => frames.push(m), tm, runner: () => live, rehello() {} };
  return { d, frames };
}

describe('noHostModelAccess (work 097): the public build, every session managed', () => {
  it('advertises nothing, calls every route managed, and never throws', async () => {
    const { d, frames } = deps();
    const a = noHostModelAccess(d);
    expect(a.features()).toBeUndefined();
    expect(a.routes.mode('k')).toBe('managed');
    a.routes.registered('k', 'id', 'claude');
    a.routes.closed('k', 'id');
    a.stop();
    expect(await a.delivered('k', creds, undefined)).toBe(creds);
    expect(await a.delivered('k', creds, { mode: 'managed' }, 'claude')).toBe(creds);
    expect(a.forRunner('k', creds)).toBe(creds);
    expect(a.forRunner('k', undefined)).toBeUndefined();
    expect(frames).toEqual([]);
  });

  it('never hands a Codex runner the organization’s Claude credentials', async () => {
    const { d } = deps(runner('codex'));
    const a = noHostModelAccess(d);
    expect(await a.delivered('k', creds, undefined, 'codex')).toEqual(slackOnly);
    expect(a.forRunner('k', creds, 'codex')).toEqual(slackOnly);
    expect(a.forRunner('k', creds)).toEqual(slackOnly); // its live runner is Codex
    expect(a.forRunner('k', undefined, 'codex')).toEqual({ slackBotToken: '', slackBotUserId: '' });
  });

  it('answers a probe `proxy_unavailable`, drops a subscription route, and leaves other frames to the host', async () => {
    const live = runner();
    const { d, frames } = deps(live);
    const a = noHostModelAccess(d);
    expect(a.onGateway({ t: 'probe', id: 'p1', token: 't' } as GatewayToHost, creds)).toBe(true);
    expect(frames).toEqual([{ t: 'probed', id: 'p1', error: 'proxy_unavailable' }]);
    const sub: GatewayToHost = { t: 'model', sessionKey: 'k', model: { mode: 'subscription', owner: 'U1', fingerprint: 'fp', token: 'tok' } };
    expect(a.onGateway(sub, creds)).toBe(true);
    expect(live.sent).toEqual([]); // nothing pushed to the runner for a route it cannot take
    expect(a.onGateway({ t: 'credentials', credentials: creds } as GatewayToHost, creds)).toBe(false);
    expect(a.routes.mode('k')).toBe('managed');
    expect(await a.delivered('k', creds, { mode: 'subscription', owner: 'U1', fingerprint: 'fp', token: 'tok' })).toBe(creds);
    // A managed push re-sends the runner what it was delivered (the hosted build does: a push back to managed carries them).
    expect(a.onGateway({ t: 'model', sessionKey: 'k', model: { mode: 'managed' } }, slackOnly)).toBe(true);
    expect(live.sent).toEqual([{ t: 'credentials', credentials: creds }]);
    expect(frames).toHaveLength(1);
  });
});

describe('the seam’s implementation', () => {
  it('createHostModelAccess builds something of the interface’s shape', () => {
    const { d } = deps();
    const a = createHostModelAccess(d);
    for (const k of ['features', 'delivered', 'forRunner', 'onGateway', 'stop'] as const) expect(typeof a[k]).toBe('function');
    for (const k of ['mode', 'registered', 'closed'] as const) expect(typeof a.routes[k]).toBe('function');
    a.stop();
  });
});

describe('the seam (work 097, 6b)', () => {
  const SRC = path.resolve(import.meta.dirname, '..');
  const HOSTED = ['host/subscriptions.ts', 'host/model-proxy.ts', 'host/model-routes.ts'];
  const IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm;
  function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
    }
  }
  /** Non-test files under src/ importing any of `targets` (paths under src/, .ts), as paths under src/. */
  const importers = (targets: string[]) => {
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(IMPORT)) {
        if (!m[1].startsWith('.')) continue;
        const target = path.relative(SRC, path.resolve(path.dirname(file), m[1])).replace(/\.js$/, '.ts');
        if (targets.includes(target)) found.push(path.relative(SRC, file));
      }
    }
    return [...new Set(found)].sort();
  };

  // In the public build the hosted modules are absent and nothing imports them (model-access.hosted.test.ts covers the hosted build).
  it('nothing but host/model-access-impl.ts imports the hosted modules (they may import each other)', () => {
    expect(importers(HOSTED).filter((f) => !HOSTED.includes(f) && f !== 'host/model-access-impl.ts')).toEqual([]);
  });

  it('host/main.ts gets its model access from the seam, not from the hosted modules', () => {
    expect(importers(['host/model-access-impl.ts'])).toEqual(['host/main.ts']);
  });
});
