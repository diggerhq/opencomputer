import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCommandUnit } from "../src/microvm/command-unit.js";

/**
 * The process unit with real processes. cgroups are disabled here so the
 * behaviour under test is the process-session fallback every host has;
 * the cgroup path is the same code with a stronger containment and is
 * exercised on the runtime image.
 */

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "command-unit-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function pidFrom(file: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const value = Number((await readFile(file, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No pid was written to ${file}`);
}

async function untilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${String(pid)} is still alive`);
}

/**
 * A real child that calls setsid(): python3 where present, perl's POSIX
 * otherwise. Either leaves the unit's process group the way a daemonizing
 * descendant does.
 */
function setsidChild(pidFile: string, sleepSeconds: number): string | undefined {
  const python = `import os, time
os.setsid()
open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))
time.sleep(${String(sleepSeconds)})`;
  // Single-quoted for the shell; the scripts carry double quotes only.
  if (spawnSync("python3", ["-c", "import os; os.setsid"]).status === 0) {
    return `python3 -c '${python}'`;
  }
  const perl = `use POSIX; POSIX::setsid(); open(F, ">", ${JSON.stringify(pidFile)}); print F $$; close F; sleep ${String(sleepSeconds)};`;
  if (spawnSync("perl", ["-MPOSIX", "-e", "1"]).status === 0) {
    return `perl -e '${perl}'`;
  }
  return undefined;
}

describe("command unit", () => {
  it("runs the command in the workspace and reports its output and exit code", async () => {
    const output: string[] = [];
    const unit = startCommandUnit({
      unitId: "unit-1",
      workspace,
      command: "pwd; echo out; echo err >&2; exit 3",
      timeoutMs: 10_000,
      cgroupRoot: "",
      onOutput: (stream, chunk) => output.push(`${stream}:${chunk}`),
    });
    const result = await unit.done;
    const lines = result.stdout.trim().split("\n");
    expect(lines.pop()).toBe("out");
    // The first line is pwd: the command runs in the workspace.
    expect(lines[0]!.endsWith(workspace.split("/").pop()!)).toBe(true);
    expect(result.stderr).toBe("err\n");
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      timedOut: false,
      terminated: false,
      truncated: false,
      isolation: "process_session",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(output.join("")).toContain("stdout:");
    expect(output.join("")).toContain("stderr:err");
  });

  it("terminates the whole unit on timeout, including a backgrounded descendant", async () => {
    const pidFile = join(workspace, "child.pid");
    const unit = startCommandUnit({
      unitId: "unit-2",
      workspace,
      command: `(sleep 30 & echo $! > ${JSON.stringify(pidFile)}); echo started; sleep 30`,
      timeoutMs: 400,
      cgroupRoot: "",
      graceMs: 200,
    });
    const child = await pidFrom(pidFile);
    expect(alive(child)).toBe(true);
    const result = await unit.done;
    expect(result).toMatchObject({ timedOut: true, terminated: true, terminationReason: "timeout" });
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    expect(result.stdout).toContain("started");
    expect(result.durationMs).toBeLessThan(10_000);
    await untilGone(child);
  });

  it("tears the unit down when the leader exits, so nothing outlives the command", async () => {
    const pidFile = join(workspace, "orphan.pid");
    const unit = startCommandUnit({
      unitId: "unit-3",
      workspace,
      command: `(sleep 30 & echo $! > ${JSON.stringify(pidFile)}); exit 0`,
      timeoutMs: 10_000,
      cgroupRoot: "",
      graceMs: 200,
    });
    const orphan = await pidFrom(pidFile);
    const result = await unit.done;
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, terminated: false });
    await untilGone(orphan);
  });

  it("terminates on request before the timeout and records the reason", async () => {
    const unit = startCommandUnit({
      unitId: "unit-4",
      workspace,
      command: "sleep 30",
      timeoutMs: 60_000,
      cgroupRoot: "",
      graceMs: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await unit.terminate("stop");
    const result = await unit.done;
    expect(result).toMatchObject({ terminated: true, timedOut: false, terminationReason: "stop" });
    expect(result.durationMs).toBeLessThan(10_000);
    // Idempotent: a second terminate is the same settled promise.
    await unit.terminate("again");
    expect((await unit.done).terminationReason).toBe("stop");
  });

  it("does not claim containment when a descendant left the process group: the unit is terminated, the descendant survives, and the result says so", async () => {
    // Review finding 3, with a real process: under the process-session
    // fallback a child that calls setsid() is out of reach of the group
    // signal. Terminating the unit must not be reported as settlement.
    const pidFile = join(workspace, "detached.pid");
    const detached = setsidChild(pidFile, 30);
    if (!detached) {
      console.warn("neither python3 nor perl is available; the setsid() reproduction is skipped here");
      return;
    }
    const unit = startCommandUnit({
      unitId: "unit-setsid",
      workspace,
      command: `(${detached} &) ; sleep 30`,
      timeoutMs: 60_000,
      cgroupRoot: "",
      graceMs: 200,
    });
    const child = await pidFrom(pidFile);
    expect(alive(child)).toBe(true);
    await unit.terminate("stop");
    const result = await unit.done;
    try {
      expect(result).toMatchObject({
        terminated: true,
        terminationReason: "stop",
        isolation: "process_session",
        contained: false,
      });
      // Terminated in well under the bounded wait, and the descendant is
      // still alive: exactly the state a settlement claim would hide.
      expect(result.durationMs).toBeLessThan(5_000);
      expect(alive(child)).toBe(true);
    } finally {
      try {
        process.kill(child, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("never reports containment under the process-session fallback, even when the leader exited on its own", async () => {
    const unit = startCommandUnit({
      unitId: "unit-plain",
      workspace,
      command: "exit 0",
      timeoutMs: 10_000,
      cgroupRoot: "",
    });
    expect(await unit.done).toMatchObject({ exitCode: 0, isolation: "process_session", contained: false });
  });

  it("keeps the uncertainty when the wait for an empty cgroup expires", async () => {
    // A cgroup v2 root as the unit sees it (cgroup.controllers present,
    // cgroup.procs writable), except that nothing ever leaves the
    // listing: the bounded wait expires and containment stays unverified.
    const cgroupRoot = join(workspace, "cgroup");
    await writeFile(join(workspace, "placeholder"), "");
    await rm(cgroupRoot, { recursive: true, force: true });
    await (await import("node:fs/promises")).mkdir(cgroupRoot, { recursive: true });
    await writeFile(join(cgroupRoot, "cgroup.controllers"), "cpu memory pids\n");
    const unit = startCommandUnit({
      unitId: "unit-cgroup-expiry",
      workspace,
      command: "echo placed; exit 0",
      timeoutMs: 10_000,
      cgroupRoot,
      graceMs: 50,
      emptyWaitMs: 150,
    });
    const result = await unit.done;
    expect(result.stdout).toBe("placed\n");
    expect(result).toMatchObject({ exitCode: 0, isolation: "cgroup", contained: false });
    expect(result.orphansTerminated).toBeGreaterThanOrEqual(1);
  });

  it("caps captured output and says so", async () => {
    const unit = startCommandUnit({
      unitId: "unit-5",
      workspace,
      command: "head -c 5000 /dev/zero | tr '\\0' 'a'",
      timeoutMs: 10_000,
      cgroupRoot: "",
      outputLimit: 1_000,
    });
    const result = await unit.done;
    expect(result.stdout).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
