import { describe, expect, it } from 'vitest';
import { mayAttach, mayOpenTerminal } from './edge-auth.js';

describe('session access', () => {
  const slack = { sessionId: 'cs_a', owner: 'usr_owner', members: ['usr_owner'] };
  it('a terminal is the owner’s, a listed person’s, or an admin’s (host list or access frame) where they may attach', () => {
    expect(mayOpenTerminal(slack, 'usr_owner', new Set())).toBe(true);
    // CTO-37 Q4: being an admin lets no one into a session that is not open to them.
    expect(mayOpenTerminal(slack, 'usr_admin', new Set(['usr_admin']))).toBe(false);
    expect(mayOpenTerminal({ ...slack, admins: ['usr_admin'] }, 'usr_admin', new Set())).toBe(false);
    const shared = { sessionId: 'cs_b', owner: 'usr_owner', members: ['usr_pat'] };
    expect(mayOpenTerminal(shared, 'usr_pat', new Set())).toBe(true);
    expect(mayOpenTerminal(shared, 'usr_admin', new Set(['usr_admin']))).toBe(false);
    const org = { sessionId: 'cs_c', owner: 'usr_owner', members: null };
    expect(mayOpenTerminal(org, 'usr_pat', new Set())).toBe(false);
    expect(mayOpenTerminal(org, 'usr_admin', new Set(['usr_admin']))).toBe(true);
    expect(mayOpenTerminal({ ...org, admins: ['usr_admin'] }, 'usr_admin', new Set())).toBe(true);
  });
  it('admins in the access frame do not widen who may attach', () => {
    expect(mayAttach({ ...slack, admins: ['usr_admin'] }, 'usr_admin')).toBe(false);
    expect(mayAttach({ ...slack, members: null }, 'usr_any')).toBe(true);
  });
});
