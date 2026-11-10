import { describe, expect, it } from 'vitest';
import { checkoutText } from './checkout.js';

describe('checkoutText', () => {
  it('reports each repository on its own line, failures and stale fetches included', () => {
    const ok = { name: 'api', dir: 'api', branch: 'sp/C1-2', from: 'origin/main', base: '0123456789abcdef' };
    expect(
      checkoutText([ok, { ...ok, name: 'web', dir: 'web', fetchError: 'timed out' }, { ...ok, name: 'nope', error: 'no repository nope' }]).split('\n'),
    ).toEqual([
      'api: checked out in ./api on sp/C1-2, from origin/main (01234567)',
      'web: checked out in ./web on sp/C1-2, from origin/main (01234567); the fetch failed (timed out), so it starts from the cached origin/main',
      'nope: not checked out: no repository nope',
    ]);
  });
});
