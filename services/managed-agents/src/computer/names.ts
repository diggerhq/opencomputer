// Names shared by the edge and the platform Worker (work 052): which ids may
// own a computer, the Azure resource name prefix of a computer, and the
// `organization` tag its resources carry. Pure.
//
// A computer's resources are named `<prefix>`, `<prefix>-nic`,
// `<prefix>-data`, `<prefix>-os`. The prefix used to be derived from the
// organization id at every call; it is now stored on the lifecycle row,
// so a computer can keep the name it was built under after it changes hands
// (the warm pool). Rows written before the
// prefix was stored fall back to the derived name, which is what they were
// created with.

const NAME_MAX = 60;

/** OpenComputer organization ids (WorkOS `org_…`) and test ids. */
export function validOrganizationId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/.test(id);
}

/**
 * `oc-` + the id, lowercased, as an Azure resource name: letters, digits and
 * single hyphens, at most 60 characters (`org_01HXYZ` → `oc-org-01hxyz`).
 * Too long: cut and suffixed with a hash of the full id so it stays unique.
 */
export function computerName(organizationId: string): string {
  if (!validOrganizationId(organizationId)) throw new Error(`invalid organization id: ${organizationId}`);
  const base = organizationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `oc-${base}`;
  if (name.length <= NAME_MAX) return name;
  return `${name.slice(0, NAME_MAX - 9).replace(/-+$/, "")}-${fnv1a(organizationId)}`;
}

/**
 * A stored resource prefix, as the platform accepts it: the shape
 * computerName produces (`oc-` and at most 57 lowercase letters, digits and
 * hyphens), so the suffixed names stay valid Azure names and nothing can
 * address a path outside the computers' resource group.
 */
export function validResourcePrefix(prefix: string): boolean {
  return /^oc-[a-z0-9-]{1,57}$/.test(prefix);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** The `organization` tag of a warm pool computer's resources, until a claim moves them to an organization. */
export const POOL_TAG = "pool";

/** The singleton ComputerDurableObject that keeps the warm pool's slots. */
export const POOL_OBJECT = "computer-pool";

/** Warm pool slot ids (`pool-<random>`): a computer that belongs to no organization yet. */
export function isPoolId(id: string): boolean {
  return /^pool-[a-z0-9]{6,40}$/.test(id);
}

/** A fresh pool slot id, `pool-` + 12 base-36 characters. */
export function newPoolId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `pool-${[...bytes].map((byte) => (byte % 36).toString(36)).join("")}`;
}

/** What the `organization` tag of a computer's resources says for this id. */
export function ownerTag(organizationId: string): string {
  return isPoolId(organizationId) ? POOL_TAG : organizationId;
}
