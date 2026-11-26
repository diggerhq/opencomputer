import { describe, expect, it } from 'vitest';
import { applyPromptCacheTtl, presetTtls, promptCacheTtls } from './cache-ttl.js';

const none = { explicit: undefined, preset: {} };

describe('prompt cache TTL', () => {
  it('the profile’s promptCacheTtl, for main and subagents', () => {
    expect(promptCacheTtls(none, '1h')).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
  });

  it('Claude Code’s default when nothing asks', () => {
    expect(promptCacheTtls(none, undefined)).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: undefined, CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: undefined });
  });

  it('SP_PROMPT_CACHE_TTL, then the preset, then the profile', () => {
    expect(promptCacheTtls({ explicit: '5m', preset: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }, '1h').CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
    expect(promptCacheTtls({ explicit: undefined, preset: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } }, '1h').CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
    expect(promptCacheTtls({ explicit: '1h', preset: {} }, undefined).CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('1h');
  });

  it('sets and clears the variables in an environment', () => {
    const env: NodeJS.ProcessEnv = {};
    const o = { explicit: undefined, preset: presetTtls(env) };
    applyPromptCacheTtl(env, o, '1h');
    expect(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('1h');
    applyPromptCacheTtl(env, o, undefined);
    expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
  });
});
