import { describe, expect, it } from "vitest";

import { renderWorkerSource } from "../src/workerd-runtime/render.js";

/**
 * Workerd renders its own worker and keeps its own copy of the tool filter, so
 * the fix in `code-tools.ts` did not reach it. A gated tool was skipped here
 * entirely — not registered, never offered, so the approval could not even be
 * asked for.
 */
describe("gated tools in the workerd runtime", () => {
  const source = renderWorkerSource(["tools/billing.js"], ["attach"], ["attach"]);

  it("admits a gated tool as a tool the model can call", () => {
    expect(source).toContain('value.kind !== "gated-tool"');
    expect(source).toContain('const gatedTools = new Set(["attach"])');
  });

  it("refuses a gated tool with no apply, rather than offering a write that cannot land", () => {
    expect(source).toContain('value.kind === "gated-tool" && typeof value.apply !== "function"');
  });

  it("refuses a tool whose gatedness disagrees with the manifest", () => {
    // Declared gated but exported plain would write without ever asking.
    expect(source).toContain("does not wait for approval");
    expect(source).toContain("is not declared gated");
  });

  it("carries no gated set when the manifest declares none", () => {
    expect(renderWorkerSource(["tools/x.js"], ["x"])).toContain(
      "const gatedTools = new Set([])",
    );
  });
});
