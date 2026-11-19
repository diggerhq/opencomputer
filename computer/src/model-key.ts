// The two short hashes of work 097 (design C2 and C6), computed the same way
// by the host and the backend (services/managed-agents src/computer/model-key.ts):
//
// - `modelKey`: a credential's `key` when its author has no better name, the
//   first 16 hex digits of sha256 over the profile, then every variable as
//   `name=value` in name order, joined by NUL. All variables sent are hashed,
//   used by the profile or not.
// - `spareKind`: what a warm-pool spare was started for, the first 16 hex
//   digits of sha256 over the harness name and the profile's `harness[h]` as
//   JSON with sorted keys (`{}` when absent), joined by NUL. A session may
//   claim a spare of its own kind.
//
// Invariant: one-way and short. `modelKey` suits high-entropy values only; the
// result may be logged and sent anywhere, the values never.

import { createHash } from 'node:crypto';
import type { HarnessName } from './protocol.js';

const hex16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/** `profile` with `vars`, as a key (C2). */
export function modelKey(profile: string, vars: Record<string, string>): string {
  const names = Object.keys(vars).sort();
  return hex16([profile, ...names.map((n) => `${n}=${vars[n]}`)].join('\0'));
}

/** JSON with every object's keys sorted, at any depth. */
export function sortedJson(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  );
}

/** A spare's kind for `harness` started with the profile's `harness[h]` object `h` (C6). */
export function spareKind(harness: HarnessName, h: unknown): string {
  return hex16(`${harness}\0${sortedJson(h ?? {})}`);
}
