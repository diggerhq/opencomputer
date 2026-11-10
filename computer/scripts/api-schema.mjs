#!/usr/bin/env node
// The Computer API's JSON Schema (work 084): src/api/schema.ts →
// schema/computer-api.v1.json, and the capabilities a session may use:
// src/api/capabilities.ts → schema/capabilities.v1.json (blue vendors it and
// tests its HTTP copy against it, review r2 P2-5). With --check (run by
// `npm run check`) it fails when a committed file differs from what the
// source emits, so the published contract never drifts from the code.
//
//   node scripts/api-schema.mjs           write it
//   node scripts/api-schema.mjs --check   compare only

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { register } from 'tsx/esm/api';

register();
const ROOT = path.resolve(import.meta.dirname, '..');
const { apiJsonSchema } = await import(path.join(ROOT, 'src/api/schema.ts'));
const { capabilities } = await import(path.join(ROOT, 'src/api/capabilities.ts'));
const files = [
  ['schema/computer-api.v1.json', apiJsonSchema(), 'src/api/schema.ts'],
  ['schema/capabilities.v1.json', capabilities(), 'src/api/capabilities.ts'],
];
for (const [rel, value, src] of files) {
  const out = path.join(ROOT, rel);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    let committed = '';
    try { committed = readFileSync(out, 'utf8'); } catch {}
    if (committed !== text) {
      console.error(`FAIL ${rel} differs from ${src}: run node scripts/api-schema.mjs and commit it`);
      process.exit(1);
    }
    console.log(`api schema ok: ${rel} matches ${src}`);
  } else {
    writeFileSync(out, text);
    console.log(`wrote ${rel} (${text.length} bytes)`);
  }
}
