import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionSecrets } from './session-secrets.js';
import { ReminderFilter } from './stream.js';

const dirs: string[] = [];
function secrets() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  dirs.push(dir);
  return new SessionSecrets(path.join(dir, 's'));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.TOKEN;
});

describe('SessionSecrets', () => {
  it('redacts known values, and leaves short ones alone', () => {
    const s = secrets();
    s.apply([
      { name: 'TOKEN', value: 'ghp_abcdefghij', scope: 'user' },
      { name: 'PIN', value: '1234', scope: 'session' },
    ]);
    expect(s.redact('use ghp_abcdefghij and 1234')).toBe('use [secret:TOKEN] and 1234');
  });

  it('puts variables in the environment but never redacts them or refuses a file with one', () => {
    const s = secrets();
    s.apply([
      { name: 'TOKEN', value: 'ghp_abcdefghij', scope: 'user' },
      { name: 'ORG', value: 'acme-corp-dev', scope: 'workspace', variable: true },
    ]);
    const values = path.join(path.dirname(s.envFile), 'values.sh');
    expect(readFileSync(values, 'utf8')).toContain(`export ORG='acme-corp-dev'`);
    expect(process.env.ORG).toBe('acme-corp-dev');
    expect(s.redact('https://github.com/acme-corp-dev/x with ghp_abcdefghij')).toBe('https://github.com/acme-corp-dev/x with [secret:TOKEN]');
    const f = new ReminderFilter((t, end) => s.filter(t, end));
    expect(f.push('see acme-corp') + f.push('-dev/x') + f.flush()).toBe('see acme-corp-dev/x');
    expect(s.foundIn(Buffer.from('org: acme-corp-dev'))).toBeUndefined();
    expect(s.foundIn(Buffer.from('ghp_abcdefghij'))).toBe('TOKEN');
    delete process.env.ORG;
  });

  it("keeps a claimed spare's session variables ahead of the secrets, through later changes", () => {
    const s = secrets();
    s.base({ SP_TEST_KEY: "C1:1.2 'x'" });
    s.apply([{ name: 'TOKEN', value: 'ghp_abcdefghij', scope: 'user' }]);
    const values = readFileSync(path.join(path.dirname(s.envFile), 'values.sh'), 'utf8');
    expect(values).toContain(`export SP_TEST_KEY='C1:1.2 '\\''x'\\'''\nexport TOKEN=`);
    expect(process.env.SP_TEST_KEY).toBe("C1:1.2 'x'");
    expect(s.redact("C1:1.2 'x'")).toBe("C1:1.2 'x'");
    delete process.env.SP_TEST_KEY;
  });

  it('holds back a streamed value split across deltas until it can tell', () => {
    const s = secrets();
    s.apply([{ name: 'TOKEN', value: 'ghp_abcdefghij', scope: 'user' }]);
    const f = new ReminderFilter((t, end) => s.filter(t, end));
    const out = f.push('key ghp_abc') + f.push('defghij done') + f.flush();
    expect(out).toBe('key [secret:TOKEN] done');
  });

  it('writes an env file that drops reserved names and unsets removed ones', () => {
    const s = secrets();
    s.apply([
      { name: 'TOKEN', value: "it's", scope: 'user' },
      { name: 'PATH', value: '/evil', scope: 'user' },
    ]);
    const values = path.join(path.dirname(s.envFile), 'values.sh');
    expect(readFileSync(values, 'utf8')).toContain(`export TOKEN='it'\\''s'`);
    expect(readFileSync(values, 'utf8')).not.toContain('PATH');
    expect(s.names).toEqual(['TOKEN']);
    s.apply([]);
    expect(readFileSync(values, 'utf8')).toContain('unset TOKEN');
    expect(process.env.TOKEN).toBeUndefined();
  });

  it('finds a value inside a file about to be sent', () => {
    const s = secrets();
    s.apply([{ name: 'TOKEN', value: 'ghp_abcdefghij', scope: 'user' }]);
    expect(s.foundIn(Buffer.from('x\nghp_abcdefghij\n'))).toBe('TOKEN');
    expect(s.foundIn(Buffer.from('nothing here'))).toBeUndefined();
  });
});
