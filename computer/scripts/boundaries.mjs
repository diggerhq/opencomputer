#!/usr/bin/env node
// Import boundaries between the four processes. Each of src/gateway, src/host,
// src/runner and src/wire (the relay, work 084) is one deployable; they share code only through the
// top-level modules of src/ (protocol.ts above all). A process importing
// another process's directory couples deployables that must be able to
// change and restart on their own, so this fails `npm run check`.
//
// Within the runner, Claude Code's SDK belongs to its harness (work 082,
// src/runner/harness/claude/): a session sees only the seam's records, and
// Calvin's tools and gate are its own (tool.ts, harness/types.ts). The list
// below is what else may import it, a dev probe of the SDK itself; it only
// shrinks. Tests are exempt.
//
// Likewise Codex's app-server protocol belongs to its harness
// (src/runner/harness/codex/): no other file names its JSON-RPC methods, and
// only runner/main.ts loads the harness, through its index and lazily, so a
// Claude runner never evaluates it. Tests are exempt.
//
// The relay is held tighter still: it runs as its own user facing clients, so
// src/wire may import only the wire contracts (protocol.ts, protocol-api.ts,
// signed-header.ts, session-ids.ts, ipc.ts, log.ts and api/*) and itself.
// Tests included.
//
//   node scripts/boundaries.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const PROCESSES = ['gateway', 'host', 'runner', 'wire'];
const WIRE_MAY = new Set(['protocol.ts', 'protocol-api.ts', 'signed-header.ts', 'session-ids.ts', 'ipc.ts', 'log.ts']);
/** Whether src/wire may import `target` (a path under src/, extension as written: .js). */
const wireMay = (target) => {
  const ts = target.replace(/\.js$/, '.ts');
  return ts.startsWith('wire/') || ts.startsWith('api/') || WIRE_MAY.has(ts);
};
const IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm;
const SDK = '@anthropic-ai/claude-agent-sdk';
const SDK_HOME = 'runner/harness/claude/';
const SDK_STILL = new Set(['dev/task-events.ts']);
const CODEX_HOME = 'runner/harness/codex/';
const CODEX_ENTRY = { from: 'runner/main.ts', target: 'runner/harness/codex/index.js' };
// A string literal naming an app-server method or notification: `initialize`
// and the protocol's namespaces (thread/, turn/, item/, account/, model/, ...).
const APP_SERVER_METHOD =
  /['"`](?:initialize|(?:thread|turn|item|account|model|serverRequest|mcpServer|config|review|fuzzyFileSearch|command|feedback)\/[A-Za-z/]+)['"`]/;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

/** The process a path under src/ belongs to, or undefined for shared and dev code. */
const processOf = (rel) => PROCESSES.find((p) => rel === p || rel.startsWith(`${p}/`));

let failed = false;
for (const file of walk(SRC)) {
  const from = path.relative(SRC, file);
  const owner = processOf(from);
  const text = readFileSync(file, 'utf8');
  const test = from.endsWith('.test.ts');
  if (!test && !from.startsWith(CODEX_HOME)) {
    const line = text.split('\n').findIndex((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l) && APP_SERVER_METHOD.test(l));
    if (line >= 0) {
      console.error(`FAIL src/${from}:${line + 1} names a Codex app-server method: only the Codex harness (src/${CODEX_HOME}) speaks its protocol`);
      failed = true;
    }
    for (const m of [...text.matchAll(IMPORT), ...text.matchAll(DYNAMIC_IMPORT)]) {
      if (!m[1].startsWith('.')) continue;
      const target = path.relative(SRC, path.resolve(path.dirname(file), m[1]));
      if (!target.startsWith(CODEX_HOME)) continue;
      const lazy = !m[0].includes('from') && m[0].startsWith('import(');
      if (from !== CODEX_ENTRY.from || target !== CODEX_ENTRY.target || !lazy) {
        console.error(`FAIL src/${from} imports src/${target}: only src/${CODEX_ENTRY.from} loads Codex, lazily through await import('./harness/codex/index.js')`);
        failed = true;
      }
    }
  }
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1];
    if (spec === SDK && !from.endsWith('.test.ts') && !from.startsWith(SDK_HOME) && !SDK_STILL.has(from)) {
      console.error(`FAIL src/${from} imports ${SDK}: only the Claude harness (src/${SDK_HOME}) may; go through the seam (harness/types.ts)`);
      failed = true;
    }
    if (!owner || !spec.startsWith('.')) continue;
    const target = path.relative(SRC, path.resolve(path.dirname(file), spec));
    if (owner === 'wire' && !wireMay(target)) {
      console.error(`FAIL src/${from} imports src/${target}: the relay imports only the wire contracts (protocol*.ts, signed-header.ts, session-ids.ts, ipc.ts, log.ts, api/*)`);
      failed = true;
    }
    const other = processOf(target);
    if (other && other !== owner) {
      console.error(`FAIL src/${from} imports src/${target}: ${owner} must not depend on ${other}; share it through src/`);
      failed = true;
    }
  }
}
for (const f of SDK_STILL) {
  if (!readFileSync(path.join(SRC, f), 'utf8').includes(SDK)) {
    console.error(`FAIL src/${f} no longer imports ${SDK}: drop it from SDK_STILL in scripts/boundaries.mjs`);
    failed = true;
  }
}
if (!failed) console.log(`boundaries ok: ${PROCESSES.join(', ')} share code only through src/; src/wire imports only the wire contracts; ${SDK} stays in src/${SDK_HOME}; Codex's app-server in src/${CODEX_HOME}`);
process.exit(failed ? 1 : 0);
