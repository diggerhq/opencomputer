import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexNatives, prereadCodex } from './codex-preread.js';

describe('prereadCodex', () => {
  it('reads the native executables an npm install puts under the launcher', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-'));
    const pkg = path.join(dir, 'lib/node_modules/@openai/codex');
    const vendor = path.join(pkg, 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin');
    mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    mkdirSync(vendor, { recursive: true });
    writeFileSync(path.join(pkg, 'bin/codex.js'), '#!/usr/bin/env node\n');
    writeFileSync(path.join(vendor, 'codex'), Buffer.alloc(3000));
    writeFileSync(path.join(vendor, 'codex-code-mode-host'), Buffer.alloc(1000));
    mkdirSync(path.join(dir, 'bin'));
    symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', path.join(dir, 'bin/codex'));
    expect((await codexNatives(path.join(dir, 'bin/codex'))).map((f) => path.basename(f))).toEqual(['codex', 'codex-code-mode-host']);
    expect(await prereadCodex(path.join(dir, 'bin/codex'))).toBe(4000);
  });

  it('reads nothing without an install', async () => {
    expect(await prereadCodex('/nonexistent/codex')).toBe(0);
  });
});
