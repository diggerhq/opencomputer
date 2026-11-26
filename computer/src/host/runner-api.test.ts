import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerApi } from '../protocol.js';
import { runnerApis } from './runner-api.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const api = (n: number): RunnerApi => ({ sessionId: `cs_${String(n).padStart(16, '0')}`, journal: `/j/${n}`, epoch: 1, lastSeq: n, socket: `/s/${n}.api.sock`, token: `t${n}` });

describe('runnerApis', () => {
  it('writes off the loop, coalescing a burst, and a restarted host reads it back', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'runner-api-'));
    const file = path.join(dir, 'run', 'runners.json');
    const a = runnerApis(file);
    for (let i = 0; i < 20; i++) a.set(`r${i}`, api(i));
    a.delete('r3');
    expect(() => statSync(file)).toThrow(); // nothing written synchronously
    await a.settled();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toHaveLength(19);
    a.retain(new Set(['r1', 'r2']));
    await a.settled();
    const b = runnerApis(file);
    expect(b.get('r1')).toEqual(api(1));
    expect(b.get('r3')).toBeUndefined();
    expect(b.get('r5')).toBeUndefined();
  });
});
