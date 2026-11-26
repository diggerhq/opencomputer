import type { SpareProcess } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

const started: { options: { settings: Record<string, unknown> } }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<object>()),
  query: (p: (typeof started)[number]) => (started.push(p), {}),
}));

const { claimHarness, startHarness } = await import('./process.js');
const { Inbox } = await import('./inbox.js');

const base = { cwd: '/w', mode: 'default', model: 'claude-opus-5-5', effort: 'medium' } as const;

describe('fast mode follows the session speed', () => {
  it.each([
    [true, true],
    [false, false],
  ])('a claim with fast=%s overlays fastMode %s next to the effort', (fast, fastMode) => {
    const claims: unknown[] = [];
    const spare = { claim: (p: unknown) => (claims.push(p), {}) } as unknown as SpareProcess;
    claimHarness(spare, new Inbox(), { ...base, fast });
    expect(claims[0]).toMatchObject({ options: { settings: { effortLevel: 'medium', fastMode } } });
  });

  it('a cold start sets fastMode from the spec, keeping the shared settings', () => {
    const calvin = {} as never;
    startHarness(new Inbox(), { ...base, fast: false, canUseTool: async () => ({ behavior: 'allow' }), calvin });
    startHarness(new Inbox(), { ...base, fast: true, canUseTool: async () => ({ behavior: 'allow' }), calvin });
    expect(started.map((p) => p.options.settings.fastMode)).toEqual([false, true]);
    expect(started[0].options.settings).toMatchObject({ precomputeCompactionEnabled: true });
  });
});
