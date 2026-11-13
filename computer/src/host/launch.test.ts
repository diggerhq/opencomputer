import { describe, expect, it } from 'vitest';
import { launchCommand, runnerCommand } from './launch.js';
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
    const vars = setenv({ PATH: '/bin', SP_COMPACT_AT: '0.8' });
    for (const k of RUNNER_ENV) expect(vars.has(k), k).toBe(true);
    expect(vars.get('PATH')).toBe('/bin');
    expect(vars.get('SP_COMPACT_AT')).toBe('0.8');
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

describe('dropEmpty', () => {
  it('unsets runner variables the host set empty, and only those', () => {
    const env: NodeJS.ProcessEnv = { SP_CODEX_BIN: '', SP_COMPACT_AT: '0.8', OTHER: '' };
    dropEmpty(env);
    expect(env).toEqual({ SP_COMPACT_AT: '0.8', OTHER: '' });
  });
});
