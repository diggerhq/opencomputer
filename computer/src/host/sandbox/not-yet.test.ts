import { describe, expect, it } from 'vitest';
import { notYet } from './not-yet.js';

describe('notYet', () => {
  it('refuses each host-side feature for a sandboxed session, in one line, and nothing for any other', () => {
    for (const what of ['preview', 'terminal', 'files', 'checkout'] as const) {
      expect(notYet(what, true)).toMatch(/^[^\n]+ not available yet for a session that runs in a container\.$/);
      expect(notYet(what, false)).toBeUndefined();
    }
  });
});
