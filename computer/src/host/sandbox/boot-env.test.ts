import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_ENV, runnerVars } from '../../runner-env.js';
import { BOOT_ENV, HOST_ONLY, bootEnv } from './boot-env.js';

const spec = { id: 'abc', socket: '/run/x/runners/abc.sock', version: 'v1', session: { key: "it's", forkPath: '/workspace' } } as never;

describe('boot.env', () => {
  it('every runner variable is in exactly one of the two lists', () => {
    const both = [...BOOT_ENV, ...HOST_ONLY] as string[];
    expect(new Set(both).size).toBe(both.length);
    expect([...both].sort()).toEqual([...RUNNER_ENV].sort());
  });

  it('is SP_ROOT, RUNNER_SPEC, then the variables in order, empty ones left out', () => {
    const text = bootEnv({ root: '/opt/slack-presence/releases/abc', spec, vars: runnerVars({ MODEL: 'm', SP_VERSION: 'v1', PATH: '/host/bin', HTTPS_PROXY: 'http://p' }) });
    expect(text.split('\n').map((l) => l.split('=')[0])).toEqual(['SP_ROOT', 'RUNNER_SPEC', 'SP_VERSION', 'MODEL', 'SP_CODEX_PEER_CHECK', 'HTTPS_PROXY', '']);
    expect(text).toContain("SP_ROOT='/opt/slack-presence/releases/abc'\n");
    expect(text).toContain("SP_CODEX_PEER_CHECK='on'\n");
    expect(text).not.toContain('PATH=');
  });

  it('never writes a host-only name, whatever the host has', () => {
    const all = Object.fromEntries(RUNNER_ENV.map((k) => [k, `/host/${k}`]));
    const names = bootEnv({ root: '/r', spec, vars: all }).trimEnd().split('\n').map((l) => l.slice(0, l.indexOf('=')));
    expect(names).toEqual(['SP_ROOT', 'RUNNER_SPEC', ...BOOT_ENV]);
  });

  it('a shell reads back exactly what was written', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'boot-env-'));
    try {
      const nasty = `a'b"c $(id) \`id\` \\ $HOME; x`;
      const file = path.join(dir, 'boot.env');
      writeFileSync(file, bootEnv({ root: '/r', spec, vars: { MODEL: nasty } }));
      const out = execFileSync('/bin/sh', ['-c', 'set -a; . "$1"; set +a; printf "%s\\n%s" "$MODEL" "$RUNNER_SPEC"', 'sh', file], { encoding: 'utf8', env: {} });
      const [model, ...rest] = out.split('\n');
      expect(model).toBe(nasty);
      expect(JSON.parse(rest.join('\n'))).toEqual(spec);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
