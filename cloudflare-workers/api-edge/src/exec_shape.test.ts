import { describe, expect, it } from "vitest";
import { buildAgentExecRequest } from "./index";

// Regression cover for a bug that produced no error signal at all: the
// microvm-direct exec path read only `cmd` and dropped `args`, so the SDK's
// {cmd:"sh", args:["-c", ...]} became `/bin/sh -lc sh` — a shell with no script,
// which exits 0 having printed nothing. Every SDK exec on a MicroVM box returned
// {exitCode: 0, stdout: ""} and looked like a command that produced no output.
describe("buildAgentExecRequest", () => {
  it("runs the argv form verbatim (the shape the SDK sends)", () => {
    const req = buildAgentExecRequest({ cmd: "sh", args: ["-c", "echo hi"] }, "sh");
    expect(req.command).toBe("/bin/sh");
    expect(req.args).toEqual(["-c", "echo hi"]);
    // The bug: the script was replaced by the program name.
    expect(req.args).not.toEqual(["-lc", "sh"]);
  });

  it("treats the string form as a shell line", () => {
    const req = buildAgentExecRequest({ cmd: "echo hi" }, "echo hi");
    expect(req.command).toBe("/bin/sh");
    expect(req.args).toEqual(["-lc", "echo hi"]);
  });

  it("keeps a non-shell program as the program", () => {
    const req = buildAgentExecRequest({ cmd: "node", args: ["-e", "console.log(1)"] }, "node");
    expect(req.command).toBe("node");
    expect(req.args).toEqual(["-e", "console.log(1)"]);
  });

  it("ignores a non-string entry rather than shipping it to the guest", () => {
    const req = buildAgentExecRequest({ cmd: "sh", args: ["-c", 42, "echo hi"] as unknown[] }, "sh");
    expect(req.args).toEqual(["-c", "echo hi"]);
  });

  it("falls back to the shell line when args is present but empty", () => {
    const req = buildAgentExecRequest({ cmd: "echo hi", args: [] }, "echo hi");
    expect(req.args).toEqual(["-lc", "echo hi"]);
  });

  it("passes cwd, env and timeout through, omitting what was not sent", () => {
    const req = buildAgentExecRequest(
      { cmd: "sh", args: ["-c", "pwd"], cwd: "/tmp", env: { A: "1" }, timeoutSeconds: 5 },
      "sh",
    );
    expect(req.cwd).toBe("/tmp");
    expect(req.env).toEqual({ A: "1" });
    expect(req.timeoutSeconds).toBe(5);
    expect(buildAgentExecRequest({ cmd: "x" }, "x").cwd).toBeUndefined();
  });
});
