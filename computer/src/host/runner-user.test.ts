import { describe, expect, it } from 'vitest';
import { runnerUser } from './runner-user.js';

describe('runner user (work 077)', () => {
  it('is nothing when unset', () => {
    expect(runnerUser({})).toBeUndefined();
  });

  it('sudo to the user with their manager’s runtime dir, and their HOME', () => {
    const u = runnerUser({ SP_RUNNER_USER: 'agent' }, () => 'agent:x:1000:1000::/data/home/agent:/bin/bash\n')!;
    expect(u.sudo).toEqual(['/usr/bin/sudo', '-n', '-u', 'agent', 'XDG_RUNTIME_DIR=/run/user/1000', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus']);
    expect(u.env).toEqual({ HOME: '/data/home/agent', USER: 'agent', SHELL: '/bin/bash' });
  });

  it('gives the user their own PATH when the host runs on another', () => {
    const u = runnerUser({ SP_RUNNER_USER: 'agent2', SP_RUNNER_PATH: '/data/home/agent/go/bin:/usr/bin' }, () => 'agent2:x:1001:1001::/data/home/agent2:/bin/sh\n')!;
    expect(u.env.PATH).toBe('/data/home/agent/go/bin:/usr/bin');
  });

  it('fails loudly on an unknown user', () => {
    expect(() => runnerUser({ SP_RUNNER_USER: 'nobody-here' }, () => '')).toThrow(/no user/);
  });
});
