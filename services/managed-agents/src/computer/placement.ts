// Where a computer's VM is built (work 106): the sizes and zones a create or
// wake may try, in order, and which cloud failures mean "try the next one".
// Pure: the settings come from config.ts, the state machine is lifecycle.ts.
//
// A create or wake asks for one size (its plan's). It may get any size of
// the same shape (vCPUs and memory) on the same disk controller: the size
// the computer last ran on first, so a computer that fell back does not pay
// a failed attempt on every wake while the shortage lasts; then the size
// asked for; then the deployment's other sizes. Each size is tried in every
// zone before the next size. The data disk is zonal, so once a host has
// used it the computer keeps its zone and only the size may change.

/** Where a computer's VM and its zonal data disk are. */
export interface Placement {
  size: string;
  zone: string;
}

/** Premium SSD v2 needs a zone; the numbers are the subscription's own (logical) zones. */
export const ZONES = ["1", "2", "3"];

export function validSize(size: string): boolean {
  return /^Standard_[A-Za-z0-9_]+$/.test(size);
}

/** v6 and v7 sizes expose disks only over NVMe; the OS finds its disks by controller, so the two kinds do not mix. */
export function nvmeSize(size: string): boolean {
  return /_v[67]$/i.test(size);
}

/**
 * vCPUs and memory of a size, without naming it: `Standard_D2as_v7` → 2
 * vCPUs, 8 GiB. D sizes have 4 GiB per vCPU (2 for the low-memory `l`
 * ones, e.g. `Standard_D16als_v7`), E 8, F 2.
 */
export function sizeShape(size: string): { vcpus: number; memoryGiB: number } {
  const match = size.match(/^Standard_([A-Z]+)(\d+)([a-z]*)/i);
  const family = match?.[1]?.toUpperCase() ?? "D";
  const vcpus = Number(match?.[2] ?? 2);
  const lowMemory = family.startsWith("D") && (match?.[3] ?? "").includes("l");
  const perVcpu = family.startsWith("E") ? 8 : family.startsWith("F") || lowMemory ? 2 : 4;
  return { vcpus, memoryGiB: vcpus * perVcpu };
}

export function sameShape(a: string, b: string): boolean {
  const [one, other] = [sizeShape(a), sizeShape(b)];
  return one.vcpus === other.vcpus && one.memoryGiB === other.memoryGiB;
}

/**
 * Every placement a create or wake asking for `asked` may get, in the order
 * tried. `sizes` are the deployment's (config.ts `sizes`), `preferred` the
 * size the computer last ran on, `pinnedZone` the zone of a data disk a
 * host has used. Never empty: the first is `asked` or `preferred`.
 */
export function candidates(input: {
  asked: string;
  sizes: string[];
  zones: string[];
  preferred?: string | null;
  pinnedZone?: string | null;
}): Placement[] {
  const { asked } = input;
  const fits = (size: string) => validSize(size) && sameShape(size, asked) && nvmeSize(size) === nvmeSize(asked);
  const preferred = input.preferred && fits(input.preferred) ? [input.preferred] : [];
  const order = [...new Set([...preferred, asked, ...input.sizes.filter(fits)])];
  const zones = input.pinnedZone ? [input.pinnedZone] : input.zones;
  return order.flatMap((size) => zones.map((zone) => ({ size, zone })));
}

/** ARM's codes for "no capacity for this size here". */
const CAPACITY_CODES = new Set([
  "ZonalAllocationFailed",
  "AllocationFailed",
  "OverconstrainedZonalAllocationRequest",
  "OverconstrainedAllocationRequest",
  "SkuNotAvailable",
  "QuotaExceeded",
]);

/**
 * The cloud has no room for this VM here, by its error code: no capacity
 * for the size in the zone, or the size family's quota is used up (ARM
 * says that as `OperationNotAllowed`, which has other meanings too, so the
 * message must name the quota). Another placement may have room.
 */
export function isCapacity(code: string | null | undefined, text: string | null | undefined): boolean {
  if (!code) return false;
  return CAPACITY_CODES.has(code) || (code === "OperationNotAllowed" && /quota/i.test(text ?? ""));
}
