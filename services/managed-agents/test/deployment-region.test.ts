import { describe, expect, it } from "vitest";

import { DEPLOYMENT_REGIONS } from "../src/protocol.js";
import {
  modalRegion,
  parseDeploymentRegion,
  parseLocationHint,
  regionHeaders,
  regionPlacement,
} from "../src/deployment-region.js";

describe("deployment region (work 057)", () => {
  it("accepts Modal's regions, treats absence as the default, and rejects anything else", () => {
    for (const region of DEPLOYMENT_REGIONS) {
      expect(parseDeploymentRegion(region)).toBe(region);
    }
    expect(parseDeploymentRegion(undefined)).toBeUndefined();
    expect(parseDeploymentRegion(null)).toBeUndefined();
    expect(parseDeploymentRegion("AU")).toBeNull();
    expect(parseDeploymentRegion("us-east-1")).toBeNull();
    expect(parseDeploymentRegion("ap-southeast-2")).toBeNull();
    expect(parseDeploymentRegion("toString")).toBeNull();
    expect(parseDeploymentRegion(1)).toBeNull();
  });

  it("passes the region to Modal as is and maps it to the nearest location hint", () => {
    expect(modalRegion("au")).toBe("au");
    expect(modalRegion("eu-west")).toBe("eu-west");
    expect(regionPlacement("au")).toEqual({ locationHint: "oc" });
    expect(regionHeaders("au")).toEqual({ "x-opencomputer-location-hint": "oc" });
    expect(regionPlacement("us-west")).toEqual({ locationHint: "wnam" });
    expect(regionPlacement("us")).toEqual({ locationHint: "enam" });
    expect(regionPlacement("uk")).toEqual({ locationHint: "weur" });
    expect(regionPlacement("jp")).toEqual({ locationHint: "apac" });
    expect(regionPlacement("sa")).toEqual({ locationHint: "sam" });
    expect(regionPlacement("af")).toEqual({ locationHint: "afr" });
    expect(regionPlacement("me")).toEqual({ locationHint: "me" });
  });

  it("places nothing without a region", () => {
    expect(modalRegion(undefined)).toBeUndefined();
    expect(regionPlacement(undefined)).toBeUndefined();
    expect(regionHeaders(undefined)).toEqual({});
  });

  it("reads back only hints a region maps to", () => {
    expect(parseLocationHint("oc")).toBe("oc");
    expect(parseLocationHint("weur")).toBe("weur");
    expect(parseLocationHint("mars")).toBeUndefined();
    expect(parseLocationHint(null)).toBeUndefined();
  });
});
