import { describe, expect, it } from 'vitest';
import { aboveCeiling, deniedLine, familyName, nextDown } from './model-downgrade.js';

describe('model downgrade (work 077)', () => {
  it('steps one family down, and stops at the bottom or an unknown model', () => {
    expect(nextDown('claude-fable-5-1')).toBe('claude-opus-5-5');
    expect(nextDown('opus')).toBe('claude-sonnet-5-5');
    expect(nextDown('claude-sonnet-5-5')).toBe('claude-haiku-5-5');
    expect(nextDown('claude-haiku-5-5')).toBeUndefined();
    expect(nextDown('some-custom-model')).toBeUndefined();
  });

  it('compares against the ceiling only when both are known families', () => {
    expect(aboveCeiling('claude-opus-5-5', 'claude-sonnet-5-5')).toBe(true);
    expect(aboveCeiling('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(false);
    expect(aboveCeiling('claude-haiku-5-5', 'claude-sonnet-5-5')).toBe(false);
    expect(aboveCeiling('claude-opus-5-5', undefined)).toBe(false);
    expect(aboveCeiling('custom', 'claude-sonnet-5-5')).toBe(false);
  });

  it('says it in family names', () => {
    expect(familyName('claude-opus-5-5')).toBe('Opus');
    expect(deniedLine('claude-fable-5-1', 'claude-opus-5-5')).toBe("Your Claude subscription doesn't include Fable; this thread is on Opus.");
  });
});
