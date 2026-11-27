// Ids as section 34.1 makes them: a prefix and Crockford base32. They become
// server row ids and idempotency keys, so they are drawn from the platform's
// crypto; a seeded source is injected only by tests.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A uniform number in [0, 1) from crypto.getRandomValues. */
export const cryptoRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

/** `<prefix>_` and `n` Crockford characters. */
export function crockfordId(prefix: string, n: number, random: () => number = cryptoRandom): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(random() * 32)];
  return `${prefix}_${s}`;
}

export function makeId(prefix: "cs" | "tn" | "at" | "trk" | "res" | "prp" | "op" | "cl" | "tr" | "ib", random?: () => number): string {
  return crockfordId(prefix, prefix === "tn" ? 12 : 16, random);
}
