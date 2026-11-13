import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HostCredentials, RunnerToHost } from '../protocol.js';
import type { HarnessEvent } from './harness/types.js';
import type { Session } from './session.js';
import { MODEL_SOCKET, noRunnerModelAccess, routeOf } from './model-access.js';
import { createRunnerModelAccess } from './model-access-impl.js';

const slack = { slackBotToken: 'xoxb', slackBotUserId: 'B1' };
const managed: HostCredentials = { ...slack, claudeOAuthToken: 'org' };
const metered: HostCredentials = { ...slack, anthropicApiKey: 'k', anthropicBaseUrl: 'https://x' };
const denied: HarnessEvent = { t: 'error', kind: 'model', code: 'model_not_found', message: '' };

function setup() {
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', HOME: '/h' };
  const s = { info: { model: 'claude-fable-5-1', userId: 'U1' }, model: 'claude-fable-5-1', maxModel: undefined, persist: vi.fn(), say: vi.fn(), send: vi.fn() };
  const out: RunnerToHost[] = [];
  const downgraded = vi.fn();
  const hooks = { session: () => s as unknown as Session, out: (m: RunnerToHost) => out.push(m), downgraded };
  return { env, s, out, downgraded, hooks };
}

describe('noRunnerModelAccess (work 097): the public build, managed credentials only', () => {
  it('reports the route the credentials carry and leaves the environment alone', async () => {
    const { env, hooks } = setup();
    const before = { ...env };
    const a = noRunnerModelAccess({ env, socket: undefined, hooks });
    expect(a.route()).toBeUndefined();
    expect(a.apply(managed)).toBe('managed');
    expect(a.route()).toBe('managed');
    expect(a.apply(slack)).toBeUndefined(); // Slack only: no Claude part
    expect(a.route()).toBe('managed');
    expect(a.apply(metered)).toBe('managed');
    await a.event(denied);
    expect(a.idle()).toBe(false);
    a.reset();
    expect(a.route()).toBeUndefined();
    expect(env).toEqual(before);
  });

  it('exports what public code shares with the hosted build', () => {
    expect(MODEL_SOCKET).toBe('/run/oc-modelproxy/api.sock');
    expect(routeOf(managed)).toBe('managed');
    expect(routeOf(metered)).toBe('managed');
    expect(routeOf(slack)).toBeUndefined();
  });
});

describe('the seam’s implementation', () => {
  it('createRunnerModelAccess builds something of the interface’s shape', () => {
    const { env, hooks } = setup();
    const a = createRunnerModelAccess({ env, socket: undefined, hooks });
    for (const k of ['route', 'reset', 'apply', 'event', 'idle'] as const) expect(typeof a[k]).toBe('function');
  });
});

describe('the seam (work 097, 6b)', () => {
  const SRC = path.resolve(import.meta.dirname, '..');
  const HOSTED = ['runner/subscription.ts'];
  const IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm;
  function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
    }
  }
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

  // In the public build the hosted module is absent and nothing imports it (model-access.hosted.test.ts covers the hosted build).
  it('nothing but runner/model-access-impl.ts imports the hosted module', () => {
    expect(importers(HOSTED).filter((f) => f !== 'runner/model-access-impl.ts')).toEqual([]);
  });

  it('runner/main.ts gets its model access from the seam; the Codex harness never imports it', () => {
    expect(importers(['runner/model-access-impl.ts'])).toEqual(['runner/main.ts']);
    expect(importers(['runner/model-access.ts']).filter((f) => f.startsWith('runner/harness/'))).toEqual([]);
  });
});
