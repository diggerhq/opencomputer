import { describe, expect, it } from 'vitest';
import { launchCommand, runnerCommand, unitFailure } from './launch.js';
import { RUNNER_ENV, dropEmpty } from '../runner-env.js';

describe('runnerCommand', () => {
  const release = new Set(['/r/.sp-version.env', '/r/dist/runner-boot.mjs']);
  it('starts the bundle when the release has one', () => {
    expect(runnerCommand('/r', (p) => release.has(p)).slice(1)).toEqual(['/r/dist/runner-boot.mjs']);
  });
  it('ignores a bundle outside a release: a checkout has one from `npm run check`', () => {
    expect(runnerCommand('/r', (p) => p === '/r/dist/runner-boot.mjs')[1]).toBe('--import');
  });
  it('falls back to the sources under tsx when the release has no bundle', () => {
    expect(runnerCommand('/r', (p) => p === '/r/.sp-version.env')[1]).toBe('--import');
  });
  it('falls back to the sources under tsx', () => {
    const [, flag, loader, main] = runnerCommand('/r', () => false);
    expect([flag, main]).toEqual(['--import', '/r/src/runner/main.ts']);
    expect(loader).toMatch(/tsx/);
  });
});

describe('launchCommand', () => {
  const rs = { id: 'r1', session: { key: 'k', forkPath: '/w' } } as never;
  /** The --setenv variables of a systemd launch. */
  const setenv = (env: NodeJS.ProcessEnv) => {
    const vars = new Map<string, string>();
    for (const a of launchCommand(rs, 'systemd', { SP_SYSTEMD_RUN: 'systemd-run --user', ...env }, '/r').args) {
      const m = /^--setenv=([^=]+)=(.*)$/s.exec(a);
      if (m) vars.set(m[1], m[2]);
    }
    return vars;
  };

  it('pins every runner variable, empty when the host has none', () => {
    const vars = setenv({ PATH: '/bin', SP_MODEL_SOCKET: '/run/m.sock' });
    for (const k of RUNNER_ENV) expect(vars.has(k), k).toBe(true);
    expect(vars.get('PATH')).toBe('/bin');
    expect(vars.get('SP_MODEL_SOCKET')).toBe('/run/m.sock');
    // Empty, not absent: absent would let the user manager's environment (set by any session) through.
    expect(vars.get('SP_CODEX_BIN')).toBe('');
  });

  it('keeps the peer check on unless the host itself runs with it off', () => {
    expect(setenv({}).get('SP_CODEX_PEER_CHECK')).toBe('on');
    expect(setenv({ SP_CODEX_PEER_CHECK: 'no' }).get('SP_CODEX_PEER_CHECK')).toBe('on');
    expect(setenv({ SP_CODEX_PEER_CHECK: 'off' }).get('SP_CODEX_PEER_CHECK')).toBe('off');
  });

  it('gives a detached runner the same variables', () => {
    const c = launchCommand(rs, 'detached', { PATH: '/bin' }, '/r');
    expect(Object.keys(c.env)).toEqual(expect.arrayContaining([...RUNNER_ENV, 'RUNNER_SPEC']));
    expect(c.env.SP_CODEX_PEER_CHECK).toBe('on');
  });
});

describe('launchCommand, podman', () => {
  const rs = { id: 'ab12', socket: '/run/x/runners/ab12.sock', version: 'v' } as never;
  const env = { SP_RUNNER_USER: 'root', SP_SYSTEMD_RUN: 'systemd-run --user --slice=s.slice' };
  const yes = () => true;

  it('starts the container attached, in a unit named by the runner, with no environment and no directory', () => {
    const c = launchCommand(rs, 'podman', env, '/r', yes);
    expect(c.detached).toBe(false);
    expect(c.cmd).toBe('/usr/bin/sudo');
    const at = c.args.indexOf('--');
    expect(c.args.slice(0, at).slice(0, 3)).toEqual(['-n', '-u', 'root']);
    expect(c.args.slice(at + 1)).toEqual([
      'systemd-run', '--user', '--slice=s.slice',
      '-p', 'Delegate=yes', '-p', 'KillMode=mixed', '-p', 'TimeoutStopSec=20', '-p', 'StandardOutput=null', '-p', 'StandardError=journal',
      '--unit=sp-runner-ab12', '--collect', '--quiet',
      '--', '/usr/bin/podman', 'start', '--attach', 'sp-runner-ab12',
    ]);
    expect(c.args.some((a) => /^--setenv|^--working-directory/.test(a))).toBe(false);
  });

  it('throws without the bundle: a container has no tsx fallback', () => {
    expect(() => launchCommand(rs, 'podman', env, '/r', () => false)).toThrow('/r/dist/runner-boot.mjs');
  });

  it('throws without a runner user, naming what sets one up', () => {
    expect(() => launchCommand(rs, 'podman', { SP_SYSTEMD_RUN: 'systemd-run --user' }, '/r', yes)).toThrow('sp-host.sh');
  });
});

describe('dropEmpty', () => {
  it('unsets runner variables the host set empty, and only those', () => {
    const env: NodeJS.ProcessEnv = { SP_CODEX_BIN: '', SP_MODEL_SOCKET: '/m', OTHER: '' };
    dropEmpty(env);
    expect(env).toEqual({ SP_MODEL_SOCKET: '/m', OTHER: '' });
  });
});

describe('unitFailure', () => {
  it('says the time only when the time ran out, else what systemd-run said last', () => {
    expect(unitFailure({ timedOut: true, stderr: '' }, 20_000)).toBe('no answer in 20000 ms');
    expect(unitFailure({ timedOut: false, stderr: 'a\nFailed to start transient service unit: no\n', code: 1 }, 20_000)).toBe('Failed to start transient service unit: no');
    expect(unitFailure({ timedOut: false, stderr: '', code: 3 }, 20_000)).toBe('exit 3');
    expect(unitFailure({ timedOut: false, stderr: '' }, 20_000)).toBe('exit by a signal');
  });
});
