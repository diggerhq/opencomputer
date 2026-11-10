// .env is both input (config token pair) and state (rotated tokens, app
// credentials, bot token after install). Values already in the process
// environment win over the file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '..', '.env');

function parse(text: string): [string, string][] {
  return text
    .split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')]);
}

export function loadEnv() {
  if (!existsSync(FILE)) return;
  for (const [k, v] of parse(readFileSync(FILE, 'utf8'))) if (process.env[k] === undefined) process.env[k] = v;
}

/** Upsert keys in .env (keeping comments and order) and in process.env. */
export function setEnv(values: Record<string, string | undefined>) {
  let lines = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n') : [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    process.env[k] = v;
    const i = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  lines = lines.filter((l, i) => l !== '' || i < lines.length - 1);
  writeFileSync(FILE, lines.join('\n') + '\n', { mode: 0o600 });
}
