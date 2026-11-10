// Memory limits of one runner's transient unit (work 052: a computer per
// organization, from 8 GiB up). Pure: the host passes os.totalmem() in.
//
// Invariants:
// - On big machines a runner keeps the limits of the 64 GiB host it was tuned
//   on: MemoryHigh=12G, MemoryMax=16G. They are caps, never exceeded.
// - On smaller machines a runner may use 60% (high: reclaim and throttle) and
//   75% (max: OOM-kill inside the unit) of the machine, so one runaway build
//   cannot take the whole computer; the runners slice (deploy/vm/limits.sh)
//   caps all runners together below that, leaving room for the OS and host.
// - High is always below max, and both are whole MiB, so systemd parses them.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const RUNNER_HIGH_CAP = 12 * GIB;
export const RUNNER_MAX_CAP = 16 * GIB;

export interface RunnerMemoryLimits {
  /** systemd MemoryHigh= value, e.g. `12G` or `4761M`. */
  high: string;
  /** systemd MemoryMax= value. */
  max: string;
}

const systemdSize = (bytes: number) => (bytes % GIB === 0 ? `${bytes / GIB}G` : `${bytes / MIB}M`);
const wholeMib = (bytes: number) => Math.floor(bytes / MIB) * MIB;

/** Per-runner MemoryHigh/MemoryMax for a machine with `totalBytes` of RAM. */
export function runnerMemoryLimits(totalBytes: number): RunnerMemoryLimits {
  const max = Math.min(RUNNER_MAX_CAP, wholeMib(totalBytes * 0.75));
  const high = Math.min(RUNNER_HIGH_CAP, wholeMib(totalBytes * 0.6));
  return { high: systemdSize(high), max: systemdSize(max) };
}

/** The default `systemd-run` prefix for runners (SP_SYSTEMD_RUN overrides it). */
export function systemdRunPrefix(totalBytes: number): string {
  const { high, max } = runnerMemoryLimits(totalBytes);
  return `systemd-run --user --slice=slack-presence-runners.slice -p MemoryHigh=${high} -p MemoryMax=${max}`;
}
