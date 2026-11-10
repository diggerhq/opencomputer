import { spawn } from "node:child_process";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * A computer command as one process unit: its own process session (so the
 * command is the leader of a fresh process group) and, where the kernel
 * offers one, its own cgroup. The unit is what a timeout or a stop
 * terminates, and what is torn down when the command's leader exits, so a
 * command's descendants never outlive the command, detached or not.
 *
 * Isolation is reported per unit. `cgroup` is complete: a descendant that
 * calls setsid() to leave the process group is still in the cgroup, and
 * `cgroup.kill` reaches it. `process_session` is the fallback where the
 * cgroup filesystem is absent or not writable: the whole process group is
 * signalled, which contains every descendant except one that started its
 * own session. The supervisor's reply carries which one applied.
 *
 * Containment is claimed only when verified (design C4): `contained` is
 * true when the unit's cgroup was confirmed empty within the bounded wait,
 * and false otherwise, including under `process_session`, where an empty
 * process group says nothing about a descendant that left it, and when
 * the cgroup wait expired with processes still listed. A result with
 * `contained: false` is a unit whose processes may still be running; the
 * caller reports that uncertainty rather than settlement.
 */
export interface CommandUnitOptions {
  unitId: string;
  workspace: string;
  command: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Per-stream capture limit; output past it is dropped and `truncated` set. */
  outputLimit?: number;
  /** Live output for progress reporting; chunks are the raw stream chunks. */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * The cgroup v2 mount to create the unit's cgroup under. Defaults to
   * `/sys/fs/cgroup`; an empty string disables cgroups (tests, hosts
   * without them).
   */
  cgroupRoot?: string;
  /** How long a SIGTERM gets before SIGKILL, when terminating the unit. */
  graceMs?: number;
  /** How long to wait for the unit to be empty after its leader exited; expiry is reported, never assumed away. */
  emptyWaitMs?: number;
}

export interface CommandUnitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The timeout terminated the unit. */
  timedOut: boolean;
  /** The unit was terminated before its leader exited on its own (timeout or a stop). */
  terminated: boolean;
  /** Why the unit was terminated, when it was. */
  terminationReason?: string;
  truncated: boolean;
  durationMs: number;
  isolation: "cgroup" | "process_session";
  /**
   * Verified containment: the unit's cgroup was confirmed empty within the
   * bounded wait. False under `process_session` (an empty process group is
   * not evidence about a descendant that left it) and when the cgroup wait
   * expired with processes still in it.
   */
  contained: boolean;
  /**
   * Processes still in the unit after the leader exited that had to be
   * killed. Only counted under cgroup isolation; -1 when unknown.
   */
  orphansTerminated: number;
}

export interface CommandUnit {
  readonly done: Promise<CommandUnitResult>;
  /**
   * Terminates every process in the unit and resolves once the leader has
   * exited and the unit is empty (bounded wait). Idempotent; the first
   * reason is the one recorded.
   */
  terminate(reason: string): Promise<void>;
}

const defaultOutputLimit = 1024 * 1024;
const defaultGraceMs = 2_000;
const defaultEmptyWaitMs = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupIsEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}

async function cgroupProcs(path: string): Promise<number[]> {
  try {
    const content = await readFile(join(path, "cgroup.procs"), "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => Number(line));
  } catch {
    return [];
  }
}

export function startCommandUnit(options: CommandUnitOptions): CommandUnit {
  const outputLimit = options.outputLimit ?? defaultOutputLimit;
  const graceMs = options.graceMs ?? defaultGraceMs;
  const emptyWaitMs = options.emptyWaitMs ?? defaultEmptyWaitMs;
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const startedAt = Date.now();

  // The leader waits on fd 3 before it execs the command, so it can be
  // placed in the unit's cgroup before it has a chance to fork anything.
  const child = spawn(
    "bash",
    ["-c", 'read -r _ <&3; exec 3<&-; exec bash -lc "$1"', "command-unit", options.command],
    {
      cwd: options.workspace,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  const pgid = child.pid;

  let stdout = "";
  let stderr = "";
  let truncated = false;
  let timedOut = false;
  let terminated = false;
  let terminationReason: string | undefined;
  let isolation: CommandUnitResult["isolation"] = "process_session";
  let contained = false;
  let cgroupPath: string | undefined;
  let spawnError: Error | undefined;

  const append = (current: string, chunk: string): string => {
    if (current.length >= outputLimit) {
      truncated = true;
      return current;
    }
    const next = current + chunk;
    if (next.length <= outputLimit) return next;
    truncated = true;
    return next.slice(0, outputLimit);
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout = append(stdout, text);
    options.onOutput?.("stdout", text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr = append(stderr, text);
    options.onOutput?.("stderr", text);
  });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("error", (error) => {
        spawnError = error;
        resolve({ exitCode: null, signal: null });
      });
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    },
  );

  const placeInCgroup = async (): Promise<void> => {
    if (!cgroupRoot || pgid === undefined) return;
    if (!existsSync(join(cgroupRoot, "cgroup.controllers"))) return;
    const path = join(cgroupRoot, "opencomputer-commands", options.unitId);
    try {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "cgroup.procs"), String(pgid));
      cgroupPath = path;
      isolation = "cgroup";
    } catch {
      // Not writable here: the process session is the unit.
      cgroupPath = undefined;
      isolation = "process_session";
    }
  };

  const release = async (): Promise<void> => {
    const go = child.stdio[3] as NodeJS.WritableStream | null | undefined;
    if (!go) return;
    await new Promise<void>((resolve) => {
      go.write("\n", () => resolve());
    });
    go.end();
  };

  /** Kill whatever is still in the unit and wait for it to be empty. */
  const emptyUnit = async (): Promise<number> => {
    if (pgid === undefined) return 0;
    let orphans = -1;
    if (cgroupPath) {
      orphans = (await cgroupProcs(cgroupPath)).length;
      if (orphans > 0) {
        signalGroup(pgid, "SIGTERM");
        for (const pid of await cgroupProcs(cgroupPath)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
        const graceDeadline = Date.now() + graceMs;
        while (Date.now() < graceDeadline && (await cgroupProcs(cgroupPath)).length > 0) {
          await sleep(25);
        }
        try {
          await writeFile(join(cgroupPath, "cgroup.kill"), "1");
        } catch {
          for (const pid of await cgroupProcs(cgroupPath)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
      }
      const deadline = Date.now() + emptyWaitMs;
      while (Date.now() < deadline && (await cgroupProcs(cgroupPath)).length > 0) {
        await sleep(25);
      }
      // Verified only by the cgroup's own word: empty before the wait ran
      // out. An expired wait leaves the uncertainty in the result.
      contained = (await cgroupProcs(cgroupPath)).length === 0;
      try {
        await rmdir(cgroupPath);
      } catch {
        // Left for the next unit's mkdir; nothing else to do.
      }
      return orphans;
    }
    if (!groupIsEmpty(pgid)) {
      signalGroup(pgid, "SIGTERM");
      const graceDeadline = Date.now() + graceMs;
      while (Date.now() < graceDeadline && !groupIsEmpty(pgid)) {
        await sleep(25);
      }
      signalGroup(pgid, "SIGKILL");
      const deadline = Date.now() + emptyWaitMs;
      while (Date.now() < deadline && !groupIsEmpty(pgid)) {
        await sleep(25);
      }
    }
    return orphans;
  };

  let terminating: Promise<void> | undefined;
  const terminate = (reason: string): Promise<void> => {
    if (terminating) return terminating;
    terminating = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        terminated = true;
        terminationReason = reason;
        if (reason === "timeout") timedOut = true;
      }
      if (pgid !== undefined) {
        signalGroup(pgid, "SIGTERM");
        const graceDeadline = Date.now() + graceMs;
        while (
          Date.now() < graceDeadline &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          await sleep(25);
        }
        if (cgroupPath) {
          try {
            await writeFile(join(cgroupPath, "cgroup.kill"), "1");
          } catch {
            signalGroup(pgid, "SIGKILL");
          }
        } else {
          signalGroup(pgid, "SIGKILL");
        }
      }
      await exited;
      await settled;
    })();
    return terminating;
  };

  const timer = setTimeout(() => {
    void terminate("timeout");
  }, options.timeoutMs);

  const settled = (async (): Promise<CommandUnitResult> => {
    await placeInCgroup();
    await release();
    const outcome = await exited;
    clearTimeout(timer);
    const orphansTerminated = spawnError ? 0 : await emptyUnit();
    if (spawnError) {
      throw spawnError;
    }
    return {
      stdout,
      stderr,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut,
      terminated,
      ...(terminationReason ? { terminationReason } : {}),
      truncated,
      durationMs: Date.now() - startedAt,
      isolation,
      contained,
      orphansTerminated,
    };
  })();
  // A failed spawn is surfaced through `done`; nothing else awaits `settled`.
  settled.catch(() => undefined);

  return {
    done: settled,
    terminate,
  };
}
