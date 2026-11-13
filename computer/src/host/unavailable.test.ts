import { describe, expect, it } from 'vitest';
import { Unavailable, unavailable } from './unavailable.js';

describe('Unavailable', () => {
  it('is told as unavailable 503 with its own words; nothing else is', () => {
    expect(unavailable(new Unavailable('The computer is updating, try again.'))).toEqual({ code: 'unavailable', message: 'The computer is updating, try again.', status: 503, retryable: true });
    expect(unavailable(new Unavailable('Gone.', false))).toMatchObject({ retryable: false });
    expect(unavailable(new Error('podman exec: /data/x'))).toBeUndefined();
  });
});
