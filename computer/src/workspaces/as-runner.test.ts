import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runnerUser } from '../host/runner-user.js';
import { command, configureAsRunner, mkdir, rm, writeFile } from './as-runner.js';

describe('as-runner', () => {
  afterEach(() => configureAsRunner(undefined, {}));

  it('runs commands as they are without a runner user, in the configured environment', () => {
    configureAsRunner(undefined, { PATH: '/usr/bin' });
    const c = command('git', ['status'], { GIT_TERMINAL_PROMPT: '0' });
    expect([c.cmd, c.args, c.env]).toEqual(['git', ['status'], { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' }]);
  });

  it('goes through sudo as the runners’ user, with their HOME and PATH', () => {
    const me = os.userInfo().username;
    configureAsRunner(runnerUser({ SP_RUNNER_USER: me, SP_RUNNER_PATH: '/data/home/agent/go/bin:/usr/bin' }), { PATH: '/usr/bin', LANG: 'C.UTF-8', FOO: 'x' });
    const c = command('git', ['status'], { GIT_TERMINAL_PROMPT: '0' });
    expect(c.cmd).toBe('/usr/bin/sudo');
    expect(c.args.slice(0, 3)).toEqual(['-n', '-u', me]);
    const rest = c.args.slice(c.args.indexOf('--') + 1);
    expect(rest[0]).toBe('env');
    expect(rest).toContain('PATH=/data/home/agent/go/bin:/usr/bin');
    expect(rest).toContain('LANG=C.UTF-8');
    expect(rest).not.toContain('FOO=x'); // not in KEEP
    expect(rest).toContain('GIT_TERMINAL_PROMPT=0');
    expect(rest.slice(-2)).toEqual(['git', 'status']);
  });

  it('writes with node:fs without a runner user', async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'as-runner-'));
    await mkdir(path.join(d, 'a', 'b'), { recursive: true });
    await writeFile(path.join(d, 'a', 'b', 'f'), 'x\n');
    expect(readFileSync(path.join(d, 'a', 'b', 'f'), 'utf8')).toBe('x\n');
    await rm(d);
    expect(existsSync(d)).toBe(false);
  });
});
