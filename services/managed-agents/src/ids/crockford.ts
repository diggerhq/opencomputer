// Random and derived ids in lowercase Crockford base32 (spec 34.1).

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** `<prefix>_` and `length` lowercase Crockford base32 characters of `bytes` (5 bits of each), random by default (spec 34.1). */
export function crockfordId(prefix: string, length = 16, bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(length))): string {
  let id = `${prefix}_`;
  for (let i = 0; i < length; i++) id += CROCKFORD[bytes[i]! & 31];
  return id;
}
