/**
 * When to grow a computer's data disk (work 071). The host reports `/data`'s
 * size and free space every 5 minutes; at GROW_AT used the disk grows by half,
 * in GIB_STEP steps, up to the ceiling. The VM grows its filesystem itself
 * (Calvin's slack-presence-grow-data.timer, every 10 minutes).
 *
 * Invariants: never shrinks; never asks again before the filesystem has caught
 * up with the last growth (so a stuck resize2fs cannot run the disk up to the
 * ceiling); never more than once per SETTLE_MS.
 */

export const GROW_AT = 0.8;
export const ALERT_AT = 0.9;
export const GIB_STEP = 64;
export const SETTLE_MS = 30 * 60_000;
/** A filesystem this close to its disk's size has caught up with it (ext4 keeps ~2% for itself). */
const CAUGHT_UP = 0.9;
const GIB = 2 ** 30;

export interface DiskReport {
  totalBytes: number;
  freeBytes: number;
}

export type DiskDecision =
  | { action: "none" }
  | { action: "grow"; diskGiB: number; usedShare: number }
  /** Over GROW_AT but the filesystem has not grown into the last growth yet. */
  | { action: "wait"; usedShare: number; filesystemGiB: number }
  /** At the ceiling and over ALERT_AT: someone has to look. */
  | { action: "ceiling"; usedShare: number };

export function diskDecision(
  report: DiskReport,
  disk: { diskGiB: number; maxGiB: number; grownAt: number },
  now: number,
): DiskDecision {
  const { totalBytes, freeBytes } = report;
  if (!(totalBytes > 0) || !(freeBytes >= 0) || freeBytes > totalBytes) return { action: "none" };
  const usedShare = 1 - freeBytes / totalBytes;
  if (usedShare < GROW_AT) return { action: "none" };
  if (disk.diskGiB >= disk.maxGiB) return usedShare >= ALERT_AT ? { action: "ceiling", usedShare } : { action: "none" };
  const filesystemGiB = totalBytes / GIB;
  if (filesystemGiB < disk.diskGiB * CAUGHT_UP || now - disk.grownAt < SETTLE_MS) return { action: "wait", usedShare, filesystemGiB };
  const wanted = Math.max(disk.diskGiB + GIB_STEP, Math.ceil(disk.diskGiB * 1.5));
  return { action: "grow", diskGiB: Math.min(disk.maxGiB, Math.ceil(wanted / GIB_STEP) * GIB_STEP), usedShare };
}
