import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tarOf } from './tar.js';

describe('tarOf', () => {
  it('is a stream tar unpacks: the files, their text and mode', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tar-'));
    const big = 'x'.repeat(1300) + 'é\n';
    execFileSync('tar', ['-x', '-f', '-', '-C', dir], { input: tarOf([{ name: '.fork.json', text: '{"a":1}\n' }, { name: 'docs/AGENTS.md', text: big }, { name: 'empty', text: '' }], 1_700_000_000_000) });
    expect(readFileSync(path.join(dir, '.fork.json'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(path.join(dir, 'docs', 'AGENTS.md'), 'utf8')).toBe(big);
    expect(readFileSync(path.join(dir, 'empty'), 'utf8')).toBe('');
    expect(statSync(path.join(dir, '.fork.json')).mtimeMs).toBe(1_700_000_000_000);
    expect(execFileSync('tar', ['-t', '-v', '-f', '-'], { input: tarOf([{ name: 'a', text: 'b' }]), encoding: 'utf8' })).toMatch(/^-rw-r--r-- /);
  });

  it('is blocks of 512 bytes, ended by two empty ones', () => {
    expect(tarOf([]).length).toBe(1024);
    expect(tarOf([{ name: 'a', text: 'b' }]).length).toBe(512 + 512 + 1024);
  });

  it('refuses a name that would land outside', () => {
    for (const name of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'n'.repeat(101)]) expect(() => tarOf([{ name, text: '' }])).toThrow('not a name');
  });
});
