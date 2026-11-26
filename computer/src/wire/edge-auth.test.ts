import { describe, expect, it } from 'vitest';
import { mayAttach, mayOpenTerminal } from './edge-auth.js';

describe('session access', () => {
  const slack = { sessionId: 'cs_a', owner: 'usr_owner', members: ['usr_owner'] };
  it('a terminal is the owner’s or a listed person’s, never by role (owner first)', () => {
    expect(mayOpenTerminal(slack, 'usr_owner')).toBe(true);
    expect(mayOpenTerminal({ ...slack, admins: ['usr_admin'] }, 'usr_admin')).toBe(false);
    const shared = { sessionId: 'cs_b', owner: 'usr_owner', members: ['usr_pat'] };
    expect(mayOpenTerminal(shared, 'usr_pat')).toBe(true);
    expect(mayOpenTerminal({ ...shared, admins: ['usr_admin'] }, 'usr_admin')).toBe(false);
    const org = { sessionId: 'cs_c', owner: 'usr_owner', members: null };
    expect(mayOpenTerminal(org, 'usr_owner')).toBe(true);
    expect(mayOpenTerminal(org, 'usr_pat')).toBe(false);
    // An admin in an organization-wide session attaches like any member, but gets no shell by role.
    expect(mayOpenTerminal({ ...org, admins: ['usr_admin'] }, 'usr_admin')).toBe(false);
  });
  it('admins in the access frame do not widen who may attach', () => {
    expect(mayAttach({ ...slack, admins: ['usr_admin'] }, 'usr_admin')).toBe(false);
    expect(mayAttach({ ...slack, members: null }, 'usr_any')).toBe(true);
  });
});
