import { describe, expect, it } from 'vitest';
import { isId, isSessionId, mintId } from './session-ids.js';

describe('session ids', () => {
  it('mints valid ids of each length', () => {
    for (let i = 0; i < 200; i++) {
      expect(isSessionId(mintId('cs'))).toBe(true);
      expect(mintId('cs')).toHaveLength(19);
      expect(isId('tn', mintId('tn'))).toBe(true);
      expect(mintId('tn')).toHaveLength(15);
    }
  });

  it('refuses the wrong prefix, length, case and excluded letters', () => {
    expect(isSessionId('cs_0123456789abcdef')).toBe(true);
    expect(isSessionId('cs_0123456789abcde')).toBe(false);
    expect(isSessionId('cs_0123456789ABCDEF')).toBe(false);
    for (const c of 'ilou') expect(isSessionId(`cs_0123456789abcde${c}`)).toBe(false);
    expect(isSessionId('tn_0123456789abcdef')).toBe(false);
    expect(isSessionId(undefined)).toBe(false);
    expect(isId('tn', 'tn_0123456789ab')).toBe(true);
  });
});
