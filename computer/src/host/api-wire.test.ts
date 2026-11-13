import { describe, expect, it } from 'vitest';
import { groupId, wireFor } from './api-wire.js';

describe('api-wire', () => {
  it('serves no relay socket where runners run as the host\'s own user (a host still running as agent, a laptop)', () => {
    expect(wireFor({ launch: 'systemd', stateDir: '/nonexistent' })).toBeUndefined();
    expect(wireFor({ launch: 'systemd', stateDir: '/nonexistent', user: { sudo: [], uid: 1500, env: {} } })).toBeTypeOf('function');
  });

  it('on a podman host it needs where a session\'s files are and how its terminal enters the sandbox', () => {
    const user = { sudo: [], uid: 1500, env: {} };
    const files = () => ({ root: '/workspace', spawn: () => Promise.reject(new Error('not used')) });
    expect(() => wireFor({ launch: 'podman', stateDir: '/nonexistent', user, files })).toThrow(/its terminal/);
    expect(wireFor({ launch: 'podman', stateDir: '/nonexistent', user, files, terminal: { enter: async () => ({ running: true, leave() {} }), hangUp() {} } })).toBeTypeOf('function');
  });

  it('reads a group\'s gid, undefined where it does not exist', () => {
    expect(groupId('sp-wire', () => 'sp-wire:x:997:sp-host\n')).toBe(997);
    expect(
      groupId('sp-wire', () => {
        throw new Error('exit 2');
      }),
    ).toBeUndefined();
  });
});
