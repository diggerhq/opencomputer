#!/usr/bin/env node
// The collector's independence, mechanically (work 054 decision 13): its
// source imports only its own files and the shared telemetry core in
// calvin/src/telemetry/, never the backend, the gateway, host or runner, and no
// packages. Anything else fails `npm test`.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../src');
const CORE = path.resolve(import.meta.dirname, '../../../src/telemetry');
const IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm;

let failed = false;
for (const name of readdirSync(SRC)) {
  if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
  const file = path.join(SRC, name);
  for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    const target = path.resolve(SRC, m[1]);
    const ok = m[1].startsWith('.') && (path.dirname(target) === SRC || path.dirname(target) === CORE);
    if (!ok) {
      console.error(`FAIL src/${name} imports ${m[1]}: the collector may import only ./ and calvin/src/telemetry/`);
      failed = true;
    }
  }
}
// The core it bundles must itself import nothing outside src/telemetry/.
for (const name of readdirSync(CORE)) {
  if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
  for (const m of readFileSync(path.join(CORE, name), 'utf8').matchAll(IMPORT)) {
    if (!m[1].startsWith('./')) {
      console.error(`FAIL src/telemetry/${name} imports ${m[1]}: the core bundled into the collector must stay self-contained`);
      failed = true;
    }
  }
}
if (!failed) console.log('imports ok: the collector bundles only itself and src/telemetry/');
process.exit(failed ? 1 : 0);
