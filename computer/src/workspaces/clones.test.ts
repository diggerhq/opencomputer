import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { isClone } from './clones.js';

test('isClone: a directory with a .git directory, and nothing else', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clones-'));
  mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true });
  mkdirSync(path.join(dir, 'real'));
  mkdirSync(path.join(dir, 'worktree'));
  writeFileSync(path.join(dir, 'worktree', '.git'), 'gitdir: elsewhere\n');
  writeFileSync(path.join(dir, '.workspace-prepared'), '');
  mkdirSync(path.join(dir, 'linked'));
  symlinkSync(path.join(dir, 'repo', '.git'), path.join(dir, 'linked', '.git'));
  expect(isClone(path.join(dir, 'repo'))).toBe(true);
  expect(isClone(path.join(dir, 'real'))).toBe(false);
  expect(isClone(path.join(dir, 'worktree'))).toBe(false);
  expect(isClone(path.join(dir, 'missing'))).toBe(false);
  // A marker file among the clones is not one, and does not stop a housekeeping pass (ENOTDIR).
  expect(isClone(path.join(dir, '.workspace-prepared'))).toBe(false);
  // A link a session left in place of .git is not followed.
  expect(isClone(path.join(dir, 'linked'))).toBe(false);
});
