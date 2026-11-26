import { describe, expect, it } from "vitest";

import {
  canonicalEnvironments,
  environmentModeFromStorage,
  resolveProjectScope,
} from "../src/edge/project-scope.js";

const single = { id: "prj_single", environmentMode: "single" as const };
const legacy = { id: "prj_legacy", environmentMode: "legacy" as const };

function scope(project: typeof single | typeof legacy, requested: unknown, options?: { legacyDefault?: "development" | "required" }) {
  const resolution = resolveProjectScope(project, requested, options);
  return resolution.ok
    ? { environment: resolution.scope.environment, compatibility: resolution.scope.compatibility }
    : { status: resolution.error.status, code: resolution.error.code };
}

describe("resolveProjectScope", () => {
  it("resolves single-mode projects to the default scope", () => {
    expect(scope(single, undefined)).toEqual({ environment: "default", compatibility: undefined });
    expect(scope(single, null)).toEqual({ environment: "default", compatibility: undefined });
    expect(scope(single, "")).toEqual({ environment: "default", compatibility: undefined });
    expect(scope(single, "default")).toEqual({ environment: "default", compatibility: undefined });
  });

  it("translates an older CLI's development default and records that it did", () => {
    expect(scope(single, "development")).toEqual({
      environment: "default",
      compatibility: "legacy-development-default",
    });
  });

  it("refuses explicit production against a single-mode project", () => {
    expect(scope(single, "production")).toEqual({ status: 409, code: "single_environment_project" });
    expect(scope(single, "production", { legacyDefault: "required" })).toEqual({
      status: 409,
      code: "single_environment_project",
    });
  });

  it("keeps legacy projects on development and production", () => {
    expect(scope(legacy, undefined)).toEqual({ environment: "development", compatibility: undefined });
    expect(scope(legacy, "development")).toEqual({ environment: "development", compatibility: undefined });
    expect(scope(legacy, "production")).toEqual({ environment: "production", compatibility: undefined });
    expect(scope(legacy, undefined, { legacyDefault: "required" })).toEqual({
      status: 400,
      code: "invalid_environment",
    });
    expect(scope(legacy, "default")).toEqual({ status: 400, code: "invalid_environment" });
  });

  it("fails closed on unknown scopes", () => {
    expect(scope(single, "staging")).toEqual({ status: 400, code: "invalid_environment" });
    expect(scope(legacy, "staging")).toEqual({ status: 400, code: "invalid_environment" });
    expect(scope(single, 42)).toEqual({ status: 400, code: "invalid_environment" });
  });
});

describe("environmentModeFromStorage", () => {
  it("reads projects that predate the column as legacy", () => {
    expect(environmentModeFromStorage(null)).toBe("legacy");
    expect(environmentModeFromStorage(undefined)).toBe("legacy");
    expect(environmentModeFromStorage("")).toBe("legacy");
    expect(environmentModeFromStorage("legacy")).toBe("legacy");
    expect(environmentModeFromStorage("single")).toBe("single");
  });

  it("refuses an unknown stored mode instead of guessing", () => {
    expect(() => environmentModeFromStorage("dual")).toThrow();
  });
});

describe("canonicalEnvironments", () => {
  it("names one scope for single and two for legacy", () => {
    expect(canonicalEnvironments("single")).toEqual(["default"]);
    expect(canonicalEnvironments("legacy")).toEqual(["development", "production"]);
  });
});
