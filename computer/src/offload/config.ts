// The offload service's settings (work 136), from /etc/opencomputer/selfhost.env
// (the unit's EnvironmentFile), read once where the service starts.
//
// Invariants:
// - Without the enable marker (/etc/opencomputer/offload.enabled) nothing is
//   read: offload is off, whatever the file says.
// - SP_OFFLOAD_BACKEND (alias SP_OFFLOAD) accepts `aws-microvm` only; anything
//   else is offload off with a warning. There is no other backend.
// - A bad tunable is a warning and its default; a missing bucket or image is
//   offload off (it cannot run), said in `off`.

import { OFFLOAD_CONTROL, type OffloadSize } from '../offload-protocol.js';

export const ENABLE_MARKER = '/etc/opencomputer/offload.enabled';
export const DRAIN_MARKER = '/etc/opencomputer/offload.draining';
export const HARD_MAX_MINUTES = 480;

export interface OffloadConfig {
  /** Undefined: the identity document's region. */
  region?: string;
  bucket: string;
  /** Image ARN per size (the MicroVM API rejects a bare name); a size without one is refused. */
  images: Partial<Record<OffloadSize, string>>;
  imageVersion?: string;
  maxConcurrent: number;
  /** Jobs that may wait for a slot; more are refused. */
  queueMax: number;
  maxMinutes: number;
  sourceMaxMb: number;
  artifactMaxMb: number;
  control: string;
  /** systemd's StateDirectory and RuntimeDirectory. */
  stateDir: string;
  runtimeDir: string;
}

export interface Loaded {
  config?: OffloadConfig;
  /** Why offload is off, when it is. */
  off?: string;
  warnings: string[];
}

function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number, warnings: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    warnings.push(`${name}=${raw} is not an integer of at least ${min}; using ${def}`);
    return def;
  }
  if (n > max) {
    warnings.push(`${name}=${raw} is over ${max}; using ${max}`);
    return max;
  }
  return n;
}

/** `marker`: whether the enable marker exists (the caller looks). */
export function loadOffloadConfig(env: NodeJS.ProcessEnv, marker: boolean): Loaded {
  const warnings: string[] = [];
  if (!marker) return { off: `offload is not enabled on this host (${ENABLE_MARKER} is absent)`, warnings };
  const backend = (env.SP_OFFLOAD_BACKEND ?? env.SP_OFFLOAD ?? '').trim();
  if (backend !== 'aws-microvm') {
    const off = backend ? `SP_OFFLOAD_BACKEND=${backend} is not supported (only aws-microvm); offload is off` : 'SP_OFFLOAD_BACKEND is not set; offload is off';
    if (backend) warnings.push(off);
    return { off, warnings };
  }
  const bucket = env.SP_OFFLOAD_BUCKET?.trim();
  if (!bucket) return { off: 'SP_OFFLOAD_BUCKET is not set; offload is off', warnings };
  const images: OffloadConfig['images'] = {};
  if (env.SP_OFFLOAD_IMAGE_S?.trim()) images.s = env.SP_OFFLOAD_IMAGE_S.trim();
  if (env.SP_OFFLOAD_IMAGE_M?.trim()) images.m = env.SP_OFFLOAD_IMAGE_M.trim();
  if (!images.s && !images.m) return { off: 'neither SP_OFFLOAD_IMAGE_S nor SP_OFFLOAD_IMAGE_M is set; offload is off', warnings };
  for (const [size, image] of Object.entries(images)) {
    if (!image.startsWith('arn:')) warnings.push(`SP_OFFLOAD_IMAGE_${size.toUpperCase()}=${image} is not an ARN; the MicroVM API rejects a bare name (use the line build-offload-image.sh printed)`);
  }
  if (!images.s) warnings.push('SP_OFFLOAD_IMAGE_S is not set: size s is refused');
  if (!images.m) warnings.push('SP_OFFLOAD_IMAGE_M is not set: size m is refused');
  const maxConcurrent = int(env, 'SP_OFFLOAD_MAX_CONCURRENT', 2, 1, 32, warnings);
  return {
    config: {
      region: env.SP_OFFLOAD_REGION?.trim() || undefined,
      bucket,
      images,
      imageVersion: env.SP_OFFLOAD_IMAGE_VERSION?.trim() || undefined,
      maxConcurrent,
      queueMax: Math.max(4, maxConcurrent * 2),
      maxMinutes: int(env, 'SP_OFFLOAD_MAX_MINUTES', 60, 1, HARD_MAX_MINUTES, warnings),
      sourceMaxMb: int(env, 'SP_OFFLOAD_SOURCE_MAX_MB', 2048, 1, 65536, warnings),
      artifactMaxMb: int(env, 'SP_OFFLOAD_ARTIFACT_MAX_MB', 2048, 1, 65536, warnings),
      control: env.SP_OFFLOAD_CONTROL?.trim() || OFFLOAD_CONTROL,
      stateDir: env.STATE_DIRECTORY?.split(':')[0] || '/var/lib/opencomputer-offload',
      runtimeDir: env.RUNTIME_DIRECTORY?.split(':')[0] || '/run/opencomputer-offload',
    },
    warnings,
  };
}
