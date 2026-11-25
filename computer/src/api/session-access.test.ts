import { describe, expect, it } from 'vitest';
import { mayAttach, mayOpenTerminal } from './session-access.js';

describe('session access', () => {
  const onlyMe = { sessionId: 'cs_a', owner: 'usr_owner', members: ['usr_owner'] };
  it('a terminal is for whoever may drive: the owner, named members, everyone when org-wide', () => {
    expect(mayOpenTerminal(onlyMe, 'usr_owner')).toBe(true);
    expect(mayOpenTerminal(onlyMe, 'usr_other')).toBe(false);
    expect(mayOpenTerminal({ ...onlyMe, members: ['usr_owner', 'usr_invited'] }, 'usr_invited')).toBe(true);
    expect(mayOpenTerminal({ ...onlyMe, members: null }, 'usr_any')).toBe(true);
  });
  it('an admin may not open a terminal in an "only me" session (Mohamed, web terminal MVP)', () => {
    expect(mayOpenTerminal({ ...onlyMe, admins: ['usr_admin'] }, 'usr_admin')).toBe(false);
  });
  it('admins in the access frame do not widen who may attach', () => {
    expect(mayAttach({ ...onlyMe, admins: ['usr_admin'] }, 'usr_admin')).toBe(false);
    expect(mayAttach({ ...onlyMe, members: null }, 'usr_any')).toBe(true);
  });
});
