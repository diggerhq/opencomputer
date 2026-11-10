import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudflared } from './cloudflared.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake cloudflared that appends "<args> <TUNNEL_TOKEN>" to a file, then lives `life` seconds. */
function fake(life: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cloudflared-'));
  const out = path.join(dir, 'runs');
  const bin = path.join(dir, 'cloudflared');
  writeFileSync(bin, `#!/bin/sh\necho "$* $TUNNEL_TOKEN \${SP_HOST_TOKEN:-none}" >> ${out}\nexec sleep ${life}\n`);
  chmodSync(bin, 0o755);
  const runs = () => { try { return readFileSync(out, 'utf8').trim().split('\n'); } catch { return []; } };
  return { bin, runs };
}

describe('cloudflared supervisor', () => {
  it('starts with the token in its environment only, restarts only when the token changes, stops with none', async () => {
    const f = fake(30);
    const c = cloudflared({ command: f.bin, env: { PATH: process.env.PATH, SP_HOST_TOKEN: 'secret' } });
    c.set('tok1');
    c.set('tok1');
    await sleep(300);
    expect(f.runs()).toEqual(['tunnel --no-autoupdate run tok1 none']);
    c.set('tok2');
    await sleep(300);
    expect(f.runs()).toEqual(['tunnel --no-autoupdate run tok1 none', 'tunnel --no-autoupdate run tok2 none']);
    expect(c.running).toBe(true);
    c.set(undefined);
    expect(c.running).toBe(false);
    c.stop();
  });

  it('restarts a child that exits', async () => {
    const f = fake(0);
    const c = cloudflared({ command: f.bin });
    c.set('tok');
    await sleep(1500);
    c.stop();
    expect(f.runs().length).toBe(2);
  });
});
