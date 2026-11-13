import { describe, expect, it } from 'vitest';
import { modelKey, sortedJson, spareKind } from './model-key.js';

// The same vectors as the backend's test (services/managed-agents test/computer-model-profiles.test.ts).
describe('modelKey (design C2)', () => {
  it('is the first 16 hex digits of sha256 over the profile and its variables in name order, joined by NUL', () => {
    // printf 'openrouter\0token=sk-or-test' | sha256sum
    expect(modelKey('openrouter', { token: 'sk-or-test' })).toBe('427939d396f90454');
    // printf 'p\0a=1\0b=2' | sha256sum
    expect(modelKey('p', { b: '2', a: '1' })).toBe('c79bd378f5b5e1f1');
  });

  it('differs by profile and by value', () => {
    const key = modelKey('openrouter', { token: 'sk-or-test' });
    expect(modelKey('anthropic-key', { token: 'sk-or-test' })).not.toBe(key);
    expect(modelKey('openrouter', { token: 'sk-or-other' })).not.toBe(key);
  });
});

describe('spareKind (design C6)', () => {
  it('hashes the harness name and its object as JSON with sorted keys', () => {
    // printf 'claude\0{"promptCacheTtl":"1h","tokenEnv":"ANTHROPIC_API_KEY"}' | sha256sum
    expect(spareKind('claude', { tokenEnv: 'ANTHROPIC_API_KEY', promptCacheTtl: '1h' })).toBe('4213d268b442d1fc');
    // printf 'codex\0{}' | sha256sum
    expect(spareKind('codex', {})).toBe('766c08abd4f9dbf2');
    expect(spareKind('codex', undefined)).toBe('766c08abd4f9dbf2');
  });

  it('is the same for equal objects in any key order, and differs by harness', () => {
    expect(spareKind('claude', { b: { y: 1, x: [2, { d: 1, c: 2 }] }, a: 1 })).toBe(spareKind('claude', { a: 1, b: { x: [2, { c: 2, d: 1 }], y: 1 } }));
    expect(spareKind('claude', {})).not.toBe(spareKind('codex', {}));
    expect(sortedJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
});
