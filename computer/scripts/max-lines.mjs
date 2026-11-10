#!/usr/bin/env node
// File-size ratchet: a source file over SOFT lines is a warning, over HARD a
// failure. Files that were already over when this landed are listed in
// ALLOWED with their size then; they may only shrink. Crossing a limit is a
// signal to split the file by concept, never a reason to raise the limit.
//
//   node scripts/max-lines.mjs            check
//   node scripts/max-lines.mjs --list     print every file over SOFT

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SOFT = 400;
const HARD = 600;
/** Files over HARD when the ratchet landed: path → lines then. Shrink, then delete the entry. */
const ALLOWED = {};
const ROOT = path.resolve(import.meta.dirname, '..');
const DIRS = ['src', 'scripts', 'telemetry/collector/src', 'telemetry/grafana'];
const EXT = new Set(['.ts', '.mjs', '.js']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXT.has(path.extname(p))) yield p;
  }
}

const list = process.argv.includes('--list');
let failed = false;
const over = [];
for (const dir of DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n').length;
    if (lines > SOFT) over.push([rel, lines]);
    const allowed = ALLOWED[rel];
    if (allowed !== undefined) {
      if (lines > allowed) {
        console.error(`FAIL ${rel}: ${lines} lines, was ${allowed} when allowlisted; it may only shrink`);
        failed = true;
      } else if (lines <= HARD) console.log(`note ${rel}: ${lines} lines, now under ${HARD}; remove it from ALLOWED in scripts/max-lines.mjs`);
    } else if (lines > HARD) {
      console.error(`FAIL ${rel}: ${lines} lines (limit ${HARD}); split it by concept`);
      failed = true;
    } else if (lines > SOFT) console.warn(`warn ${rel}: ${lines} lines (over ${SOFT}); consider splitting`);
  }
}
if (list) for (const [rel, n] of over.sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)} ${rel}`);
process.exit(failed ? 1 : 0);
