import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { EffortLevel, Speed } from '../protocol.js';
import { CLAUDE_CAPS } from './harness/claude/harness.js';
import { CODEX_CAPS } from './harness/codex/harness.js';
import type { Harness, HarnessId } from './harness/types.js';
import { type ModelHost, switchEffort, switchModel, switchSpeed } from './model-switch.js';
import { tierOf } from '../tiers.js';

/** A session on `id`'s harness, recording what it was asked and said. */
function host(id: HarnessId) {
  const set: { model?: string; effort?: EffortLevel; speed?: Speed } = {};
  const said: string[] = [];
  const harness = {
    id,
    caps: id === 'codex' ? CODEX_CAPS : CLAUDE_CAPS,
    setModel: (m: string) => Effect.sync(() => void (set.model = m)),
    setEffort: (e: EffortLevel) => Effect.sync(() => void (set.effort = e)),
    setSpeed: (v: Speed) => Effect.sync(() => void (set.speed = v)),
    models: Effect.succeed([]),
  } as unknown as Harness;
  const s: ModelHost = {
    info: { kind: 'thread' },
    model: id === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5',
    isBusy: false,
    say: async (t) => void said.push(t),
    ensureHarness: () => harness,
    persist: () => {},
    updateContextBar: async () => {},
  };
  return { s, set, said };
}

describe('tiers per harness', () => {
  it.each([
    ['claude', 'smart', 'claude-fable-5-2'],
    ['claude', 'fast', 'claude-sonnet-5-5'],
    ['codex', 'smart', 'gpt-6-astra'],
    ['codex', 'FAST', 'gpt-6-luna'],
  ] as const)('%s: %s is %s', async (id, tier, model) => {
    const { s, set } = host(id);
    await switchModel(s, tier);
    expect(set.model).toBe(model);
    expect(s.info.model).toBe(model);
    expect(tierOf(model)).toBe(tier.toLowerCase());
  });

  it("codex: default is Codex's, a no-op on it", async () => {
    const { s, set, said } = host('codex');
    await switchModel(s, 'default');
    expect(set.model).toBeUndefined();
    expect(said[0]).toContain('(already)');
  });

  it('an id that is not a tier goes to the harness as is', async () => {
    const { s, set } = host('codex');
    await switchModel(s, 'constructor');
    expect(set.model).toBe('constructor');
  });
});

describe('efforts per harness', () => {
  it('codex takes ultra', async () => {
    const { s, set } = host('codex');
    await switchEffort(s, 'ultra');
    expect(set.effort).toBe('ultra');
    expect(s.info.effort).toBe('ultra');
  });

  it("claude refuses ultra and lists its own", async () => {
    const { s, set, said } = host('claude');
    await switchEffort(s, 'ultra');
    expect(set.effort).toBeUndefined();
    expect(said[0]).toContain('`max`');
    expect(said[0]).not.toContain('ultra');
  });
});

describe('speed', () => {
  it('standard reaches the harness and the session; no value shows fast, the default', async () => {
    const { s, set, said } = host('claude');
    await switchSpeed(s, '');
    expect(said[0]).toBe('speed: `fast`\nchoices: `fast`, `standard`');
    await switchSpeed(s, 'Standard');
    expect(set.speed).toBe('standard');
    expect(s.info.speed).toBe('standard');
    await switchSpeed(s, 'slow');
    expect(set.speed).toBe('standard');
    expect(said.at(-1)).toContain('speed: `standard`');
  });
});
