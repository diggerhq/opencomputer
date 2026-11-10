import { describe, expect, it } from "vitest";

import { diskDecision, SETTLE_MS } from "../src/computer/disk-growth.js";

/** The data disk grows on its own near capacity (work 071). */

const GIB = 2 ** 30;
/** A report from a filesystem of `fsGiB` with `usedPct` used. */
const report = (fsGiB: number, usedPct: number) => ({ totalBytes: fsGiB * GIB, freeBytes: Math.round(fsGiB * GIB * (1 - usedPct / 100)) });
const disk = (diskGiB: number, grownAt = 0) => ({ diskGiB, maxGiB: 1024, grownAt });
const NOW = 10 * SETTLE_MS;

describe("diskDecision", () => {
  it("leaves a disk under 80% alone", () => {
    expect(diskDecision(report(125, 79), disk(128), NOW)).toEqual({ action: "none" });
  });

  it("grows by half, in 64 GiB steps, at 80%", () => {
    expect(diskDecision(report(125, 80), disk(128), NOW)).toMatchObject({ action: "grow", diskGiB: 192 });
    expect(diskDecision(report(188, 95), disk(192), NOW)).toMatchObject({ action: "grow", diskGiB: 320 });
    // A small disk still grows by at least one step.
    expect(diskDecision(report(30, 90), disk(32), NOW)).toMatchObject({ action: "grow", diskGiB: 128 });
  });

  it("stops at the ceiling, and asks for help over 90% there", () => {
    expect(diskDecision(report(700, 85), { diskGiB: 704, maxGiB: 1024, grownAt: 0 }, NOW)).toMatchObject({ action: "grow", diskGiB: 1024 });
    expect(diskDecision(report(1000, 85), { diskGiB: 1024, maxGiB: 1024, grownAt: 0 }, NOW)).toEqual({ action: "none" });
    expect(diskDecision(report(1000, 92), { diskGiB: 1024, maxGiB: 1024, grownAt: 0 }, NOW)).toMatchObject({ action: "ceiling" });
  });

  it("waits for the filesystem to grow into the last growth, and between growths", () => {
    // Disk already 192 GiB, filesystem still 125: resize2fs has not run yet.
    expect(diskDecision(report(125, 95), disk(192), NOW)).toMatchObject({ action: "wait" });
    expect(diskDecision(report(188, 95), disk(192, NOW - SETTLE_MS + 1), NOW)).toMatchObject({ action: "wait" });
    expect(diskDecision(report(188, 95), disk(192, NOW - SETTLE_MS), NOW)).toMatchObject({ action: "grow" });
  });

  it("ignores nonsense", () => {
    expect(diskDecision({ totalBytes: 0, freeBytes: 0 }, disk(128), NOW)).toEqual({ action: "none" });
    expect(diskDecision({ totalBytes: 10, freeBytes: 20 }, disk(128), NOW)).toEqual({ action: "none" });
    expect(diskDecision({ totalBytes: Number.NaN, freeBytes: 1 }, disk(128), NOW)).toEqual({ action: "none" });
  });
});
