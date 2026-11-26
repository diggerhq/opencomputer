import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { missingEdgeConfig, sizes, zones } from "../src/actors/computer/config.js";
import { candidates, isCapacity, isQuota, sameShape, sizeShape, standsIn } from "../src/actors/computer/machine/placement.js";

// Work 106: where a computer may be built (placement.ts) and the settings that say so (config.ts).
const env = (vars: Record<string, string>) => vars as never;
const D16 = "Standard_D16as_v7";

describe("placement settings", () => {
  const configured = { COMPUTERS: {}, RUNTIMES: {}, COMPUTER_HOST_GATEWAY_URL: "wss://edge.example", COMPUTER_HOST_TOKEN_KEY: "k", COMPUTER_DEFAULT_SIZE: D16 };
  const missing = (vars: Record<string, string>) => missingEdgeConfig({ ...configured, ...vars } as never);

  it("reads the zones in the configured order; unset is 1, 2, 3", () => {
    expect(zones(env({}))).toEqual(["1", "2", "3"]);
    expect(zones(env({ COMPUTER_ZONES: "2, 3,2" }))).toEqual(["2", "3"]);
  });

  it("the deployment's sizes are the plans' sizes, then the fallback sizes", () => {
    expect(sizes(env({}))).toEqual(["Standard_D2as_v7"]);
    expect(sizes(env({ COMPUTER_DEFAULT_SIZE: D16, COMPUTER_MAX_SIZE: "Standard_D32as_v7", COMPUTER_FALLBACK_SIZES: "Standard_D16s_v7, Standard_D16as_v7" }))).toEqual([
      D16,
      "Standard_D32as_v7",
      "Standard_D16s_v7",
    ]);
  });

  it("a zone or size list that is not one stops creates, by name, instead of being ignored", () => {
    expect(missing({ COMPUTER_ZONES: "2,1", COMPUTER_FALLBACK_SIZES: "Standard_D16s_v7" })).toEqual([]);
    expect(missing({ COMPUTER_ZONES: "east" })).toEqual(["COMPUTER_ZONES (not a list of zones 1 to 3)"]);
    expect(missing({ COMPUTER_FALLBACK_SIZES: "Standard_D16s_v7;D16as_v6" })).toEqual(["COMPUTER_FALLBACK_SIZES (not a list of sizes)"]);
    expect(missing({ COMPUTER_VMS: "self-managed", COMPUTER_ZONES: "east" })).toEqual([]);
  });

  it("a fallback size no plan's size could use stops creates too: a typo, another shape, arm64", () => {
    expect(missing({ COMPUTER_FALLBACK_SIZES: "Standard_D16s_v7,Standard_D8s_v7,Standard_D16ps_v6" })).toEqual([
      "COMPUTER_FALLBACK_SIZES (Standard_D8s_v7, Standard_D16ps_v6 cannot stand in for Standard_D16as_v7)",
    ]);
    expect(missing({ COMPUTER_MAX_SIZE: "Standard_D32as_v7", COMPUTER_FALLBACK_SIZES: "Standard_D32s_v7" })).toEqual([]);
  });

  it("the committed production settings are valid", () => {
    // Comments in the file are whole lines.
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../wrangler.production.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const vars = (JSON.parse(text) as { vars: Record<string, string> }).vars;
    expect(missingEdgeConfig({ ...configured, ...vars } as never)).toEqual([]);
  });
});

describe("placements", () => {
  it.each([
    ["Standard_D2as_v7", 2, 8],
    [D16, 16, 64],
    ["Standard_D16als_v7", 16, 32],
    ["Standard_D16ls_v6", 16, 32],
    ["Standard_E8as_v7", 8, 64],
    ["Standard_E16-8as_v5", 16, 128],
    ["Standard_F4s_v2", 4, 8],
    ["garbage", 2, 8],
  ])("%s is %i vCPUs and %i GiB", (size, vcpus, memoryGiB) => {
    expect(sizeShape(size)).toEqual({ vcpus, memoryGiB });
  });

  it.each([
    ["Standard_D16s_v7", true],
    ["Standard_D16as_v6", true],
    [D16, true],
    // Half the memory, another controller, arm64, a local disk, no premium storage, a family whose memory the name does not tell.
    ["Standard_D16als_v7", false],
    ["Standard_D16as_v5", false],
    ["Standard_D16ps_v6", false],
    ["Standard_D16ads_v7", false],
    ["Standard_D16a_v7", false],
    ["Standard_F32as_v7", false],
    ["Standard_DC16as_v6", false],
    ["Standard_D8as_v7", false],
    ["bogus", false],
  ])("%s stands in for Standard_D16as_v7: %s", (size, expected) => {
    expect(standsIn(size, D16)).toBe(expected);
    expect(sameShape(D16, "Standard_D16s_v7")).toBe(true);
  });

  it("tries the size asked for in every zone, then each other size that can stand in for it", () => {
    const all = ["Standard_D16s_v7", "Standard_D8as_v7", "Standard_D16as_v5", "Standard_E16as_v7", "Standard_D16als_v7", "bogus", D16, "Standard_D16as_v6"];
    expect(candidates({ asked: D16, sizes: all, zones: ["3", "1"] })).toEqual([
      { size: D16, zone: "3" },
      { size: D16, zone: "1" },
      { size: "Standard_D16s_v7", zone: "3" },
      { size: "Standard_D16s_v7", zone: "1" },
      { size: "Standard_D16as_v6", zone: "3" },
      { size: "Standard_D16as_v6", zone: "1" },
    ]);
    expect(candidates({ asked: "Standard_D8as_v7", sizes: all, zones: ["1"] })).toEqual([{ size: "Standard_D8as_v7", zone: "1" }]);
    // A size the deployment does not list is still built when asked for.
    expect(candidates({ asked: "Standard_F4s_v2", sizes: [], zones: ["2"] })).toEqual([{ size: "Standard_F4s_v2", zone: "2" }]);
  });

  it("puts the size last run on first while the deployment lists it, and keeps a used disk's zone", () => {
    const input = { asked: D16, sizes: [D16, "Standard_D16s_v7"], zones: ["1", "2"] };
    const order = (extra: object) => candidates({ ...input, ...extra }).map((placement) => `${placement.size}@${placement.zone}`);
    expect(order({ preferred: "Standard_D16s_v7" })).toEqual(["Standard_D16s_v7@1", "Standard_D16s_v7@2", `${D16}@1`, `${D16}@2`]);
    expect(order({ preferred: "Standard_D16s_v7", pinnedZone: "2" })).toEqual(["Standard_D16s_v7@2", `${D16}@2`]);
    // No longer listed, another shape (the plan changed) or another disk controller: not tried.
    for (const preferred of ["Standard_D16as_v6", "Standard_D2as_v7", "Standard_D16as_v5"]) {
      expect(order({ preferred, pinnedZone: "2" })).toEqual([`${D16}@2`, "Standard_D16s_v7@2"]);
    }
  });

  it.each([
    ["ZonalAllocationFailed", null, true, false],
    ["AllocationFailed", null, true, false],
    ["OverconstrainedZonalAllocationRequest", null, true, false],
    ["OverconstrainedAllocationRequest", null, true, false],
    ["SkuNotAvailable", null, true, false],
    ["QuotaExceeded", null, true, true],
    ["OperationNotAllowed", "exceeding approved standardDSv7Family Cores quota", true, true],
    ["OperationNotAllowed", "the disk is being attached", false, false],
    ["Conflict", "Allocation failed", false, false],
    [undefined, "quota", false, false],
  ])("code %s (%s): capacity %s, quota %s", (code, text, capacity, quota) => {
    expect(isCapacity(code, text)).toBe(capacity);
    expect(isQuota(code, text)).toBe(quota);
  });
});
