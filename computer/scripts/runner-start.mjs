#!/usr/bin/env node
// Runner start time, tsx against the bundle (work 082): starts spare runners
// the way the host does, alternating the two, and prints the median time from
// process start to the socket listening, to the first frame and to Claude Code
// parked and ready. No Slack and no credentials needed.
//
//   node scripts/bundle-runner.mjs && node scripts/runner-start.mjs [rounds]

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const rounds = Number(process.argv[2] ?? 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(mode) {
  const run = mkdtempSync(path.join(os.tmpdir(), 'sp-start-'));
  const socket = path.join(run, 'runners', 'r1.sock');
  const args = mode === 'tsx' ? ['--import', 'tsx', path.join(ROOT, 'src/runner/main.ts')] : [path.join(ROOT, 'dist/runner-boot.mjs')];
  const t0 = performance.now();
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, SP_RUN: run, HOME: run, RUNNER_SPEC: JSON.stringify({ id: 'r1', socket, version: 'bench' }) }, stdio: 'ignore' });
  try {
    while (!existsSync(socket)) {
      if (performance.now() - t0 > 20_000) throw new Error(`${mode}: no socket after 20 s`);
      await sleep(2);
    }
    const listen = performance.now() - t0;
    const { first, ready } = await new Promise((resolve, reject) => {
      const c = net.connect(socket);
      let buf = '';
      let first;
      setTimeout(() => (c.destroy(), reject(new Error(`${mode}: not ready after 30 s`))), 30_000).unref();
      c.on('data', (d) => {
        const lines = (buf += d).split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const m = JSON.parse(line);
          if (m.t !== 'spare') continue;
          first ??= performance.now() - t0;
          if (m.spare.ready) resolve({ first, ready: performance.now() - t0 }), c.destroy();
        }
      });
    });
    return { listen, first, ready };
  } finally {
    p.kill();
    rmSync(run, { recursive: true, force: true });
  }
}

const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
const results = { tsx: [], bundle: [] };
for (let i = 0; i < rounds; i++) for (const mode of Object.keys(results)) results[mode].push(await once(mode));
for (const [mode, rs] of Object.entries(results))
  console.log(`${mode.padEnd(6)} listen ${Math.round(median(rs.map((r) => r.listen)))} ms · first frame ${Math.round(median(rs.map((r) => r.first)))} ms · ready ${Math.round(median(rs.map((r) => r.ready)))} ms (median of ${rounds})`);
