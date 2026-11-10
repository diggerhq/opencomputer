// The API's ids (work 084), as calvin's src/session-ids.ts mints and checks them: a prefix and
// lowercase Crockford base32 (0-9, a-z without i, l, o, u). Sessions are `cs_` + 16, minted by the
// client that creates them (opc mints before it dials) or here; never parsed for meaning.
//
// Also the member id: the API's Person.id and the wire's member, `usr_…`. A WorkOS user id
// `user_01J…` maps to `usr_01j…` (reversible: WorkOS ids are upper-case Crockford ULIDs); anything
// else (a dashboard user id of another shape, a local dev identity) to `usr_x` + 26 hex of its
// SHA-256, stable and opaque.

export const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

const LENGTHS = { cs: 16, ev: 16, tn: 12, ak: 12, tm: 12, wc: 12 } as const;
export type IdPrefix = keyof typeof LENGTHS;

const PATTERNS = Object.fromEntries(
  Object.entries(LENGTHS).map(([p, n]) => [p, new RegExp(`^${p}_[0-9a-hjkmnp-tv-z]{${n}}$`)]),
) as Record<IdPrefix, RegExp>;

/** A fresh id: `<prefix>_` and its length of random Crockford characters (5 bits each). */
export function mintId(prefix: IdPrefix): string {
  const n = LENGTHS[prefix];
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = `${prefix}_`;
  for (let i = 0; i < n; i++) out += CROCKFORD[bytes[i]! & 31];
  return out;
}

export function isId(prefix: IdPrefix, id: unknown): id is string {
  return typeof id === "string" && PATTERNS[prefix].test(id);
}

/** A session id: `cs_` + 16. */
export const isSessionId = (id: unknown): id is string => isId("cs", id);

const WORKOS_USER = /^user_([0-9A-HJKMNP-TV-Z]{26})$/;
const MEMBER = /^usr_[0-9a-z]{1,64}$/;

/** The member id (`usr_…`) of a dashboard user id. Synchronous for WorkOS ids; others hash. */
export async function memberId(userId: string): Promise<string> {
  const workos = WORKOS_USER.exec(userId);
  if (workos) return `usr_${workos[1]!.toLowerCase()}`;
  const known = HASHED.get(userId);
  if (known) return known;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId)));
  const member = `usr_x${[...digest.slice(0, 13)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  // A pure function of the id: memoised per isolate, bounded (oldest out first).
  if (HASHED.size >= HASHED_MAX) HASHED.delete(HASHED.keys().next().value!);
  HASHED.set(userId, member);
  return member;
}

const HASHED = new Map<string, string>();
const HASHED_MAX = 1_024;

/** The WorkOS user id behind a member id, when it is one (`usr_01j…` → `user_01J…`). */
export function workOsUserOf(member: string): string | null {
  const m = /^usr_([0-9a-hjkmnp-tv-z]{26})$/.exec(member);
  return m ? `user_${m[1]!.toUpperCase()}` : null;
}

export const isMemberId = (id: unknown): id is string => typeof id === "string" && MEMBER.test(id);
