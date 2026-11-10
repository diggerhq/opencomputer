import { describe, expect, it } from 'vitest';
import { applyContextWindow, contextWindow } from './context-window.js';

describe('context window', () => {
  it('183k (compacting near 150k) unless told otherwise', () => {
    expect(contextWindow(undefined, undefined)).toBe('183000');
    expect(contextWindow('', undefined)).toBe('183000');
  });

  it('SP_CONTEXT_WINDOW wins; 0 leaves Claude Code’s default', () => {
    expect(contextWindow('200000', '120000')).toBe('200000');
    expect(contextWindow('0', '120000')).toBeUndefined();
  });

  it('keeps a window the process was started with', () => {
    expect(contextWindow(undefined, '120000')).toBe('120000');
  });

  it('ignores anything but a token count', () => {
    expect(contextWindow('150k', undefined)).toBe('183000');
    expect(contextWindow(undefined, 'big')).toBe('183000');
  });

  it('sets and clears the variable', () => {
    const env: NodeJS.ProcessEnv = {};
    applyContextWindow(env);
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('183000');
    env.SP_CONTEXT_WINDOW = '0';
    applyContextWindow(env);
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});
