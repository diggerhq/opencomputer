import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type { HarnessName, RunnerModel, RunnerToHost } from '../protocol.js';
import type { HarnessEvent } from './harness/types.js';
import { NO_FIT, runnerModelAccess } from './model-access.js';
import type { Session } from './session.js';

const SOCK = '/run/oc-modelproxy/api.sock';
const route = (harness: unknown, more: Partial<RunnerModel> = {}): RunnerModel => ({
  profile: 'anthropic-key',
  key: 'ANTHROPIC_API_KEY',
  harness,
  endpoint: { unixSocket: SOCK },
  placeholder: 'ph',
  ...more,
});
const denied: HarnessEvent = { t: 'error', kind: 'model', code: 'model_not_found', message: '' };

function setup(o: { session?: boolean; harness?: HarnessName; ttl?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'stale', ANTHROPIC_AUTH_TOKEN: 'stale', HOME: '/h' };
  const setModel = vi.fn(() => Effect.void);
  const s = {
    info: { model: 'claude-opus-5-5', userId: 'U1' },
    get model() {
      return this.info.model;
    },
    maxModel: undefined as string | undefined,
    persist: vi.fn(),
    say: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    ensureHarness: () => ({ setModel }),
  };
  const out: RunnerToHost[] = [];
  const downgraded = vi.fn();
  const a = runnerModelAccess({
    env,
    cacheTtl: { explicit: o.ttl, preset: {} },
    hooks: {
      session: () => (o.session === false ? undefined : (s as unknown as Session)),
      harness: () => o.harness ?? 'claude',
      out: (m) => out.push(m),
      downgraded,
    },
  });
  return { a, env, s, out, downgraded, setModel };
}

describe('runnerModelAccess: the Claude adapter (work 097 C5)', () => {
  it.each([
    ['ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'ph' }, ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']],
    ['ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_TOKEN: 'ph', ANTHROPIC_API_KEY: '' }, ['CLAUDE_CODE_OAUTH_TOKEN']],
    ['CLAUDE_CODE_OAUTH_TOKEN', { CLAUDE_CODE_OAUTH_TOKEN: 'ph' }, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']],
  ])('tokenEnv %s: the placeholder there, through the socket', (tokenEnv, set, unset) => {
    const { a, env } = setup();
    expect(a.apply(route({ tokenEnv }))).toBe('set');
    expect(env).toMatchObject({
      ...set,
      ANTHROPIC_BASE_URL: 'http://api.anthropic.com',
      ANTHROPIC_UNIX_SOCKET: SOCK,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      HOME: '/h',
    });
    for (const k of unset) expect(env).not.toHaveProperty(k);
    expect(a.refusal()).toBeUndefined();
    expect(a.profile()).toBe('anthropic-key');
    expect(a.endpoint()).toEqual({ unixSocket: SOCK, placeholder: 'ph' });
  });

  it.each([
    ['no tokenEnv', {}],
    ['another tokenEnv', { tokenEnv: 'OPENAI_API_KEY' }],
    ['an unknown field', { tokenEnv: 'ANTHROPIC_API_KEY', extra: 1 }],
    ['a wrong type', { tokenEnv: 'ANTHROPIC_API_KEY', downgradeOnModelRefusal: 'yes' }],
    ['not an object', 'claude'],
  ])('malformed (%s): nothing set, the turn refused', (_, harness) => {
    const { a, env } = setup();
    expect(a.apply(route(harness))).toBeUndefined();
    expect(a.refusal()).toBe(NO_FIT);
    expect(a.kind()).toBeUndefined();
    expect(env).toEqual({ HOME: '/h' });
  });

  it('no route yet: the turn is refused; an absent model keeps the current one', () => {
    const { a } = setup();
    expect(a.refusal()).toBe(NO_FIT);
    expect(a.apply(undefined)).toBeUndefined();
    a.apply(route({ tokenEnv: 'ANTHROPIC_API_KEY' }));
    expect(a.apply(undefined)).toBeUndefined();
    expect(a.refusal()).toBeUndefined();
  });

  it("the cache TTL: SP_PROMPT_CACHE_TTL over the profile's", () => {
    const own = setup();
    own.a.apply(route({ tokenEnv: 'ANTHROPIC_API_KEY', promptCacheTtl: '1h' }));
    expect(own.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
    const explicit = setup({ ttl: '5m' });
    explicit.a.apply(route({ tokenEnv: 'ANTHROPIC_API_KEY', promptCacheTtl: '1h' }));
    expect(explicit.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
  });
});

describe('runnerModelAccess: a later route', () => {
  const first = route({ tokenEnv: 'ANTHROPIC_API_KEY' });

  it("a session's runner: a changed harness object, endpoint or placeholder is a switch; the key alone changes nothing", () => {
    for (const next of [
      route({ tokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN' }),
      route({ tokenEnv: 'ANTHROPIC_API_KEY' }, { endpoint: { unixSocket: '/other.sock' } }),
      route({ tokenEnv: 'ANTHROPIC_API_KEY' }, { placeholder: 'other' }),
    ]) {
      const { a, env } = setup();
      a.apply(first);
      const before = { ...env };
      expect(a.apply(next)).toBe('switch');
      expect(env).toEqual(before);
    }
    const { a, env } = setup();
    a.apply(first);
    const before = { ...env };
    expect(a.apply(route({ tokenEnv: 'ANTHROPIC_API_KEY' }, { key: 'OTHER_KEY', profile: 'other' }))).toBeUndefined();
    expect(env).toEqual(before);
    expect(a.profile()).toBe('other');
  });

  it('a spare: the new route is applied, to park again on it', () => {
    const { a, env } = setup({ session: false });
    a.apply(first);
    const k = a.kind();
    expect(a.apply(route({ tokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN' }))).toBe('set');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('ph');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(a.kind()).not.toBe(k);
  });

  it('a spare claimed for Codex: reset clears the route but keeps the endpoint', () => {
    const { a, env } = setup({ session: false });
    a.apply(first);
    a.reset();
    expect(a.refusal()).toBe(NO_FIT);
    expect(a.endpoint()).toEqual({ unixSocket: SOCK, placeholder: 'ph' });
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_UNIX_SOCKET']) expect(env).not.toHaveProperty(k);
  });

  it("Codex reads {} and leaves Claude's environment alone", () => {
    const { a, env } = setup({ harness: 'codex', session: false });
    expect(a.apply(route({}))).toBe('set');
    expect(a.refusal()).toBeUndefined();
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'stale', ANTHROPIC_AUTH_TOKEN: 'stale', HOME: '/h' });
    const bad = setup({ harness: 'codex' });
    expect(bad.a.apply(route({ tokenEnv: 'ANTHROPIC_API_KEY' }))).toBeUndefined();
    expect(bad.a.refusal()).toBe(NO_FIT);
  });
});

describe('runnerModelAccess: the ceiling and a refused model', () => {
  it("maxModel caps the session on any route, moving a model above it down", () => {
    const { a, s } = setup();
    a.apply(route({ tokenEnv: 'ANTHROPIC_API_KEY' }, { maxModel: 'claude-sonnet-5-5' }));
    expect(s.maxModel).toBe('claude-sonnet-5-5');
    expect(s.info.model).toBe('claude-sonnet-5-5');
    expect(s.persist).toHaveBeenCalled();
  });

  it('without downgradeOnModelRefusal, a refusal stays an error', async () => {
    const { a, out, setModel } = setup();
    a.apply(route({ tokenEnv: 'ANTHROPIC_API_KEY' }));
    await a.event(denied);
    expect(setModel).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(a.idle()).toBe(false);
  });

  it('with it, the model steps down a family and the turn is retried', async () => {
    const { a, s, out, downgraded, setModel } = setup();
    a.apply(route({ tokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN', downgradeOnModelRefusal: true }));
    await a.event(denied);
    expect(setModel).toHaveBeenCalledOnce();
    const to = s.info.model;
    expect(to).not.toBe('claude-opus-5-5');
    expect(s.maxModel).toBe(to);
    expect(out).toEqual([{ t: 'model-denied', model: 'claude-opus-5-5', fallbackTo: to }]);
    expect(downgraded).toHaveBeenCalledWith('claude-opus-5-5', to);
    expect(s.say).toHaveBeenCalledOnce();
    expect(a.idle()).toBe(true);
    expect(s.send).toHaveBeenCalledOnce();
    expect(a.idle()).toBe(false);
  });
});
