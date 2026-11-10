import { describe, expect, it } from 'vitest';
import { applyPromptCacheTtl, presetTtls, promptCacheTtls } from './cache-ttl.js';

describe('prompt cache TTL', () => {
  it('1h for main and subagents on Anthropic’s own API', () => {
    expect(promptCacheTtls(undefined, {}, undefined)).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
  });

  it('Claude Code’s default through a compatible endpoint, unless asked', () => {
    const url = 'https://openrouter.ai/api';
    expect(promptCacheTtls(undefined, {}, url)).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: undefined, CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: undefined });
    expect(promptCacheTtls('1h', {}, url).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
  });

  it('1h through a subscription’s tunnel, which names Anthropic’s API (work 077)', () => {
    expect(promptCacheTtls(undefined, {}, 'http://api.anthropic.com').CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
  });

  it('SP_PROMPT_CACHE_TTL wins over the variables the process started with', () => {
    expect(promptCacheTtls('5m', { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, undefined).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
    expect(promptCacheTtls(undefined, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, undefined).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
  });

  it('follows the endpoint when the credentials change', () => {
    const env: NodeJS.ProcessEnv = {};
    const preset = presetTtls(env);
    applyPromptCacheTtl(env, undefined, preset);
    expect(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('1h');
    env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
    applyPromptCacheTtl(env, undefined, preset);
    expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
  });
});
