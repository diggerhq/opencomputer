import { describe, expect, it, vi } from "vitest";

import {
  dispatchToolExecution,
  resolveToolExecution,
} from "../src/workerd-runtime/execution-policy.js";

describe("tool execution policy", () => {
  it.each([undefined, null, "", "workerd", "sandbox"])(
    "fails %p closed to the sandbox",
    (value) => {
      expect(resolveToolExecution(value)).toBe("sandbox");
    },
  );

  it("allows an explicit audited edge tool to stay at the edge", async () => {
    const edge = vi.fn(() => "edge result");
    const sandbox = vi.fn(() => "sandbox result");

    await expect(
      dispatchToolExecution("edge", { edge, sandbox }),
    ).resolves.toBe("edge result");
    expect(edge).toHaveBeenCalledOnce();
    expect(sandbox).not.toHaveBeenCalled();
  });

  it("routes missing metadata to the sandbox", async () => {
    const edge = vi.fn(() => "edge result");
    const sandbox = vi.fn(() => "sandbox result");

    await expect(
      dispatchToolExecution(undefined, { edge, sandbox }),
    ).resolves.toBe("sandbox result");
    expect(sandbox).toHaveBeenCalledOnce();
    expect(edge).not.toHaveBeenCalled();
  });
});
