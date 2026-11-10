import { describe, expect, it } from 'vitest';
import { mayAttach, mayOpenTerminal } from './edge-auth.js';

describe('session access', () => {
  const slack = { sessionId: 'cs_a', owner: 'usr_owner', members: ['usr_owner'] };
  it('a terminal is the owner’s, or an admin’s from the host list or the access frame', () => {
    expect(mayOpenTerminal(slack, 'usr_owner', new Set())).toBe(true);
    expect(mayOpenTerminal(slack, 'usr_admin', new Set())).toBe(false);
    expect(mayOpenTerminal(slack, 'usr_admin', new Set(['usr_admin']))).toBe(true);
    expect(mayOpenTerminal({ ...slack, admins: ['usr_admin'] }, 'usr_admin', new Set())).toBe(true);
  });
  it('admins in the access frame do not widen who may attach', () => {
    expect(mayAttach({ ...slack, admins: ['usr_admin'] }, 'usr_admin')).toBe(false);
    expect(mayAttach({ ...slack, members: null }, 'usr_any')).toBe(true);
  });
});
