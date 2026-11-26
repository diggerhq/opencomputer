// Memory limits of one runner's transient unit (work 052: a computer per
// organization, from 8 GiB up). Pure: the host passes os.totalmem() in.
//
// Invariants:
// - On big machines a runner keeps the limits of the 64 GiB host it was tuned
//   on: MemoryHigh=12G, MemoryMax=16G. They are caps, never exceeded.
//   SP_RUNNER_MEMORY_MAX replaces the 16G cap (large builds on a self-hosted
//   computer); the high cap follows at 75% of it, so unset means 12G/16G.
// - On smaller machines a runner may use 60% (high: reclaim and throttle) and
//   75% (max: OOM-kill inside the unit) of the machine, so one runaway build
//   cannot take the whole computer; the runners slice (deploy/vm/limits.sh)
//   caps all runners together below that, leaving room for the OS and host.
//   A raised cap never lifts these ceilings.
// - High is always below max, and both are whole MiB, so systemd parses them.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const RUNNER_MAX_CAP = 16 * GIB;
/** The smallest SP_RUNNER_MEMORY_MAX accepted: below it a runner's own Node and Claude Code are OOM-killed. */
export const RUNNER_MAX_CAP_MIN = 1 * GIB;

export interface RunnerMemoryLimits {
  /** systemd MemoryHigh= value, e.g. `12G` or `4761M`. */
  high: string;
  /** systemd MemoryMax= value. */
  max: string;
}

const systemdSize = (bytes: number) => (bytes % GIB === 0 ? `${bytes / GIB}G` : `${bytes / MIB}M`);
const wholeMib = (bytes: number) => Math.floor(bytes / MIB) * MIB;

/**
 * Bytes of a size as systemd writes it: `17179869184`, `16384M`, `16G`, `16GiB`
 * (K, M, G, T: powers of 1024, case-insensitive). Anything else is undefined.
 */
export function parseSize(value: string): number | undefined {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)(?:([KMGT])(?:iB)?)?$/i);
  if (!m) return undefined;
  const bytes = Number(m[1]) * 1024 ** ' KMGT'.indexOf((m[2] ?? ' ').toUpperCase());
  return Number.isFinite(bytes) ? bytes : undefined;
}

/**
 * The runner MemoryMax cap from SP_RUNNER_MEMORY_MAX: unset or empty is 16G;
 * a value that does not parse or is under 1G is 16G too, with the reason.
 */
export function runnerMaxCap(value: string | undefined): { cap: number; error?: string } {
  if (value === undefined || value.trim() === '') return { cap: RUNNER_MAX_CAP };
  const bytes = parseSize(value);
  if (bytes === undefined) return { cap: RUNNER_MAX_CAP, error: `SP_RUNNER_MEMORY_MAX=${value} is not a size (e.g. 32G, 32GiB, 32768M)` };
  if (bytes < RUNNER_MAX_CAP_MIN) return { cap: RUNNER_MAX_CAP, error: `SP_RUNNER_MEMORY_MAX=${value} is under the minimum of 1G` };
  return { cap: wholeMib(bytes) };
}

/** Per-runner MemoryHigh/MemoryMax for a machine with `totalBytes` of RAM, MemoryMax at most `maxCap`. */
export function runnerMemoryLimits(totalBytes: number, maxCap = RUNNER_MAX_CAP): RunnerMemoryLimits {
  const max = Math.min(maxCap, wholeMib(totalBytes * 0.75));
  const high = Math.min(wholeMib(maxCap * 0.75), wholeMib(totalBytes * 0.6));
  return { high: systemdSize(high), max: systemdSize(max) };
}

/** The default `systemd-run` prefix for runners (SP_SYSTEMD_RUN overrides it). */
export function systemdRunPrefix(totalBytes: number, maxCap = RUNNER_MAX_CAP): string {
  const { high, max } = runnerMemoryLimits(totalBytes, maxCap);
  return `systemd-run --user --slice=slack-presence-runners.slice -p MemoryHigh=${high} -p MemoryMax=${max}`;
}
