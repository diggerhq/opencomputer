// The API's ids (work 084): a prefix and lowercase Crockford base32
// (0-9, a-z without i, l, o, u). Sessions are `cs_` + 16, minted by the client
// that creates them (opc mints before it dials, so the create and the attach
// race nowhere) or by the gateway; events `ev_` + 16; turns, asks, terminals,
// wire connections and subagents a prefix + 12. Validated wherever an id is accepted
// from outside; never parsed for meaning.

import { randomBytes } from 'node:crypto';

export const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

const LENGTHS = { cs: 16, ev: 16, tn: 12, ak: 12, tm: 12, wc: 12, sa: 12 } as const;
export type IdPrefix = keyof typeof LENGTHS;

const PATTERNS = Object.fromEntries(
  Object.entries(LENGTHS).map(([p, n]) => [p, new RegExp(`^${p}_[0-9a-hjkmnp-tv-z]{${n}}$`)]),
) as Record<IdPrefix, RegExp>;

/** A fresh id: `<prefix>_` and its length of random Crockford characters (5 bits each). */
export function mintId(prefix: IdPrefix): string {
  const n = LENGTHS[prefix];
  const bytes = randomBytes(n);
  let out = `${prefix}_`;
  for (let i = 0; i < n; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

export function isId(prefix: IdPrefix, id: unknown): id is string {
  return typeof id === 'string' && PATTERNS[prefix].test(id);
}

/** A session id: `cs_` + 16. */
export const isSessionId = (id: unknown): id is string => isId('cs', id);
export const SESSION_ID_PATTERN = PATTERNS.cs.source;
