import { describe, it, expect } from "vitest";
import {
  RUNTIME_MICROVM,
  RUNTIME_QEMU,
  effectiveRuntime,
  isMicrovmWorkerID,
  sdkMajor,
} from "./runtime_gate";

const on = {};                          // gate enabled, default threshold
const off = { SDK_RUNTIME_GATE: "0" };

// The cutoff is the package's first stable major, not the "v2" the docs use for
// the platform generation. Every version ever published is 0.x.
const NEW = "1.0.0";
const OLD = "0.15.7";

describe("sdkMajor", () => {
  it("reads the major", () => {
    expect(sdkMajor("2.0.0")).toBe(2);
    expect(sdkMajor("10.4.1")).toBe(10);
    expect(sdkMajor(" 2.1.0 ")).toBe(2);
  });

  // Everything unrecognisable is an SDK that does not announce itself, and that
  // population must land on QEMU. A parse that fell through to "new runtime"
  // would migrate every curl user and every old SDK at once.
  it("is 0 for anything it cannot read", () => {
    for (const bad of [null, undefined, "", "   ", "v2", "abc", "-3", "0.1.0"]) {
      expect(sdkMajor(bad)).toBe(0);
    }
  });
});

describe("effectiveRuntime", () => {
  it("routes an unpinned org by the calling SDK — this is the migration", () => {
    expect(effectiveRuntime(on, null, NEW)).toBe(RUNTIME_MICROVM);
    expect(effectiveRuntime(on, "", NEW)).toBe(RUNTIME_MICROVM);
    expect(effectiveRuntime(on, null, OLD)).toBe("");
    expect(effectiveRuntime(on, null, null)).toBe("");
  });

  // Every 0.x release in npm's history has to land on QEMU. Getting this wrong
  // migrates the entire existing customer base on the next deploy.
  it("holds the whole published 0.x line on the fleet", () => {
    for (const v of ["0.15.7", "0.15.0", "0.14.0", "0.13.1", "0.9.9", "0.0.1"]) {
      expect(effectiveRuntime(on, null, v), v).toBe("");
    }
  });

  // A migrated org must not be dragged back by one stale service still on an
  // old SDK — its templates and checkpoints only exist on the runtime it moved
  // to.
  it("keeps a microvm-pinned org on microvm for old SDKs", () => {
    expect(effectiveRuntime(on, RUNTIME_MICROVM, OLD)).toBe(RUNTIME_MICROVM);
    expect(effectiveRuntime(on, RUNTIME_MICROVM, null)).toBe(RUNTIME_MICROVM);
  });

  // ...and the opt-out has to survive an upgrade, or an org that needs
  // checkpoints loses them by bumping a dependency.
  it("keeps a qemu-pinned org on qemu for new SDKs", () => {
    expect(effectiveRuntime(on, RUNTIME_QEMU, NEW)).toBe(RUNTIME_QEMU);
  });

  // The token carries this value. Synthesising "qemu" for an org that never set
  // it would have the token assert a decision nobody made.
  it("never invents an explicit qemu for an unset org", () => {
    expect(effectiveRuntime(on, null, OLD)).toBe("");
    expect(effectiveRuntime(off, null, NEW)).toBe("");
  });

  it("SDK_RUNTIME_GATE=0 turns the whole thing off without touching pins", () => {
    expect(effectiveRuntime(off, null, NEW)).toBe("");
    expect(effectiveRuntime(off, RUNTIME_MICROVM, OLD)).toBe(RUNTIME_MICROVM);
  });

  it("honours a configured threshold", () => {
    const env = { SDK_RUNTIME_MIN_MAJOR: "3" };
    expect(effectiveRuntime(env, null, "2.9.0")).toBe("");
    expect(effectiveRuntime(env, null, "3.0.0")).toBe(RUNTIME_MICROVM);
    // Garbage falls back to the default rather than to 0, which would route
    // EVERY versioned SDK to microvm.
    expect(effectiveRuntime({ SDK_RUNTIME_MIN_MAJOR: "junk" }, null, OLD)).toBe("");
    expect(effectiveRuntime({ SDK_RUNTIME_MIN_MAJOR: "junk" }, null, NEW)).toBe(RUNTIME_MICROVM);
  });
});

describe("isMicrovmWorkerID", () => {
  it("recognises both prefixes internal/api/microvm_common.go writes", () => {
    expect(isMicrovmWorkerID("vmhost:microvm-abc123")).toBe(true);
    expect(isMicrovmWorkerID("microvm:abc123")).toBe(true);
  });

  it("does not claim a QEMU worker or an unknown row", () => {
    for (const other of ["worker-eastus2-3", "oc-worker-01", "", null, undefined]) {
      expect(isMicrovmWorkerID(other)).toBe(false);
    }
  });
});
