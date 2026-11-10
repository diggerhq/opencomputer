import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexHome, codexRoot } from '../codex-home.js';
import { configureAsRunner } from './as-runner.js';
import { removeCodexHome } from './codex-homes.js';
import { pruneFork } from './index.js';

let home: string;
/** A session's CODEX_HOME with a rollout in it, as Codex leaves one. */
function codexState(key: string) {
  const h = codexHome(codexRoot(home), key);
  mkdirSync(path.join(h, 'sessions/2026/10/23'), { recursive: true });
  writeFileSync(path.join(h, 'sessions/2026/10/23/rollout.jsonl'), '{}\n');
  return h;
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'codex-homes-'));
  configureAsRunner(undefined, { HOME: home });
});
afterEach(() => {
  configureAsRunner(undefined, {});
  rmSync(home, { recursive: true, force: true });
});

describe('codex homes', () => {
  it("removes the session's home, and only that one", async () => {
    const mine = codexState('T1-C1-1.2');
    const other = codexState('T1-C1-1.3');
    expect(await removeCodexHome('T1-C1-1.2')).toBe(mine);
    expect([existsSync(mine), existsSync(other)]).toEqual([false, true]);
    // None (a Claude session): not an error.
    expect(await removeCodexHome('T1-C1-9.9')).toBeDefined();
  });

  it('goes with the fork when pruneFork removes it', async () => {
    const h = codexState('T1-C1-1.2');
    const fork = path.join(home, 'sessions/T1-C1-1-2');
    mkdirSync(fork, { recursive: true });
    writeFileSync(path.join(fork, '.fork.json'), JSON.stringify({ key: 'T1-C1-1.2' }));
    expect(await pruneFork(fork)).toBeUndefined();
    expect([existsSync(fork), existsSync(h)]).toEqual([false, false]);
  });
});
