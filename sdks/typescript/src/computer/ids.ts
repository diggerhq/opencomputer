// Ids as section 34.1 makes them: a prefix and Crockford base32.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function makeId(prefix: "cs" | "tn" | "trk" | "res" | "prp" | "op" | "cl" | "tr" | "ib", random: () => number = Math.random): string {
  const n = prefix === "tn" ? 12 : 16;
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(random() * 32)];
  return `${prefix}_${s}`;
}
