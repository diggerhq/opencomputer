import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SDK_VERSION, SDK_VERSION_HEADER, sdkVersionHeaders } from "./version.js";

describe("SDK version", () => {
  // The server routes creates by the MAJOR of this value. If the constant drifts
  // from the published version, a v2 release goes out still announcing whatever
  // was hardcoded — and every customer who upgrades stays on the old runtime
  // with no error anywhere.
  it("matches package.json", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  // HTTP/2 rejects upper-case header names outright, and this SDK speaks h2.
  it("uses a lower-case header name", () => {
    expect(SDK_VERSION_HEADER).toBe(SDK_VERSION_HEADER.toLowerCase());
  });

  // Every previously published version is 0.x, so a major of at least 1 is what
  // separates a caller routed to MicroVM from one that is not.
  it("announces a stable major", () => {
    expect(Number(SDK_VERSION.split(".")[0])).toBeGreaterThanOrEqual(1);
    expect(sdkVersionHeaders()[SDK_VERSION_HEADER]).toBe(SDK_VERSION);
  });
});
