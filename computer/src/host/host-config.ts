// The host agent's settings (host.env, host.local.env, the unit's drop-ins),
// read and checked once at start; main.ts passes the fields on, so no other
// host module reads them from the environment. Pure: main.ts passes
// process.env and os.totalmem() in, and logs the warnings.
//
// Invariants:
// - A tunable that does not parse (a number, a size, a launch mode) is a
//   warning and its default: one typo must not take every session of the
//   computer down. Unset or empty is the default without a warning.
// - Only what has no default throws: a `podman` host without its runner
//   user, image or ABI would run sessions as the host or in nothing (the
//   checks sandbox/host.ts makes too).
// - Identity (gateway URL, token, id) is identity.ts's: it has a saved file.
// - Variables passed through to runners (runner-env.ts) are not settings of
//   the host and stay in the environment.

import { runnerMaxCap, systemdRunPrefix } from './runner-limits.js';

export type LaunchMode = 'systemd' | 'podman' | 'detached';
const LAUNCH_MODES: readonly string[] = ['systemd', 'podman', 'detached'];

export interface HostConfig {
  /** SP_LAUNCH: systemd on Linux, detached elsewhere. */
  launch: LaunchMode;
  /** SP_IDLE_MS: a runner without deliveries this long is told to exit. */
  idleMs: number;
  /** SP_POOL_SIZE: spare runners kept parked; 0: off. */
  poolSize: number;
  /** SP_SWEEP_AGE_MS: podman's sweep age; undefined: sweep.ts's default. */
  sweepAgeMs?: number;
  /** SP_VERSION as given; identity.ts `codeVersion` falls back to git. */
  version?: string;
  /** SP_IMAGE and SP_IMAGE_ABI: the session image (podman). */
  image?: string;
  imageAbi?: string;
  /** SP_RUNNER_MEMORY_MAX in bytes: the default prefix's MemoryMax cap. */
  runnerMemoryMax: number;
  /** The prefix runners' units start with: SP_SYSTEMD_RUN, else sized from the machine and runnerMemoryMax. */
  systemdRun: string;
  /** SP_RUNNER_USER and SP_RUNNER_PATH (runner-user.ts resolves the user). */
  runnerUser?: string;
  runnerPath?: string;
  /** SP_MODEL_PROXY: the proxy's control socket; SP_MODEL_SOCKET: where runners reach its API. */
  modelProxy?: string;
  modelSocket?: string;
  /** SP_OFFLOAD_CONTROL: the build offload service's control socket (work 136, offload-relay.ts); unset: no offload. Podman hosts only. */
  offloadSocket?: string;
  /** SP_TELEMETRY_URL, SP_TELEMETRY_CREDENTIAL, SP_REGION (`unknown`), SP_SUBSTRATE. */
  telemetry: { url?: string; credential?: string; region: string; substrate?: string };
}

export const IDLE_MS = 2 * 3600_000;
export const POOL_SIZE = 2;

/** A set, non-blank value, trimmed; else undefined. */
const given = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

/** The host's settings from `env`, and what was wrong with them. Throws only for what has no default. */
export function loadHostConfig(env: NodeJS.ProcessEnv, totalBytes: number, platform: NodeJS.Platform = process.platform): { config: HostConfig; warnings: string[] } {
  const warnings: string[] = [];
  /** A whole number of at least `min`, else `fallback` (and a warning when it was set). */
  const whole = (name: string, fallback: number, min: number): number => {
    const v = given(env[name]);
    if (v === undefined) return fallback;
    if (/^\d+$/.test(v) && Number(v) >= min) return Number(v);
    warnings.push(`${name}=${v} is not a whole number of at least ${min}; using ${fallback}`);
    return fallback;
  };

  const defaultLaunch: LaunchMode = platform === 'linux' ? 'systemd' : 'detached';
  const rawLaunch = given(env.SP_LAUNCH);
  let launch: LaunchMode = defaultLaunch;
  if (rawLaunch && LAUNCH_MODES.includes(rawLaunch)) launch = rawLaunch as LaunchMode;
  else if (rawLaunch) warnings.push(`SP_LAUNCH=${rawLaunch} is not systemd, podman or detached; using ${defaultLaunch}`);

  const sweep = whole('SP_SWEEP_AGE_MS', 0, 1);

  const memory = runnerMaxCap(env.SP_RUNNER_MEMORY_MAX);
  if (memory.error) warnings.push(`${memory.error}; runners keep MemoryMax at most 16G`);
  const systemdRun = given(env.SP_SYSTEMD_RUN);
  if (systemdRun && given(env.SP_RUNNER_MEMORY_MAX) && !memory.error) warnings.push("SP_RUNNER_MEMORY_MAX is ignored: SP_SYSTEMD_RUN sets the runners' memory limits");

  const config: HostConfig = {
    launch,
    idleMs: whole('SP_IDLE_MS', IDLE_MS, 1),
    poolSize: whole('SP_POOL_SIZE', POOL_SIZE, 0),
    sweepAgeMs: sweep || undefined,
    version: given(env.SP_VERSION),
    image: given(env.SP_IMAGE),
    imageAbi: given(env.SP_IMAGE_ABI),
    runnerMemoryMax: memory.cap,
    systemdRun: systemdRun ?? systemdRunPrefix(totalBytes, memory.cap),
    runnerUser: given(env.SP_RUNNER_USER),
    runnerPath: given(env.SP_RUNNER_PATH),
    modelProxy: given(env.SP_MODEL_PROXY),
    modelSocket: given(env.SP_MODEL_SOCKET),
    offloadSocket: given(env.SP_OFFLOAD_CONTROL),
    telemetry: { url: given(env.SP_TELEMETRY_URL), credential: given(env.SP_TELEMETRY_CREDENTIAL), region: given(env.SP_REGION) ?? 'unknown', substrate: given(env.SP_SUBSTRATE) },
  };

  if (config.launch === 'podman') {
    if (!config.runnerUser) throw new Error('SP_LAUNCH=podman needs a runner user (SP_RUNNER_USER): this host would run sessions as itself. deploy/vm/sp-host.sh sets one up.');
    if (!config.image || !config.imageAbi) throw new Error("SP_LAUNCH=podman needs SP_IMAGE and SP_IMAGE_ABI; the release's .sp-version.env sets both");
  }
  return { config, warnings };
}
