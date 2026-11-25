import { describe, expect, it } from 'vitest';
import { IDLE_MS, loadHostConfig, POOL_SIZE } from './host-config.js';

const GIB = 1024 ** 3;
const load = (env: NodeJS.ProcessEnv, total = 64 * GIB, platform: NodeJS.Platform = 'linux') => loadHostConfig(env, total, platform);
const PODMAN = { SP_LAUNCH: 'podman', SP_RUNNER_USER: 'agent', SP_IMAGE: 'ghcr.io/x/y:1', SP_IMAGE_ABI: '3' };

describe('loadHostConfig', () => {
  it('has the defaults of before, and no warning, for an empty environment', () => {
    const { config, warnings } = load({});
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      launch: 'systemd', idleMs: 7_200_000, poolSize: 2, sweepAgeMs: undefined, version: undefined, image: undefined, imageAbi: undefined,
      runnerMemoryMax: 16 * GIB, systemdRun: 'systemd-run --user --slice=slack-presence-runners.slice -p MemoryHigh=12G -p MemoryMax=16G',
      runnerUser: undefined, runnerPath: undefined, modelProxy: undefined, modelSocket: undefined,
      telemetry: { url: undefined, credential: undefined, region: 'unknown', substrate: undefined },
    });
    expect(load({}, 64 * GIB, 'darwin').config.launch).toBe('detached');
  });

  it('treats empty and blank values as unset', () => {
    const { config, warnings } = load({ SP_IDLE_MS: '', SP_POOL_SIZE: ' ', SP_LAUNCH: '', SP_RUNNER_MEMORY_MAX: '', SP_SYSTEMD_RUN: '', SP_REGION: '', SP_MODEL_SOCKET: '' });
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({ idleMs: IDLE_MS, poolSize: POOL_SIZE, launch: 'systemd', runnerMemoryMax: 16 * GIB, modelSocket: undefined, telemetry: { region: 'unknown' } });
    expect(config.systemdRun).toContain('MemoryMax=16G');
  });

  it('takes valid values', () => {
    const { config, warnings } = load({
      ...PODMAN, SP_IDLE_MS: '600000', SP_POOL_SIZE: '0', SP_SWEEP_AGE_MS: '60000', SP_VERSION: 'abc123', SP_RUNNER_PATH: '/usr/bin:/bin',
      SP_MODEL_PROXY: '/run/p/control.sock', SP_MODEL_SOCKET: '/run/p/api.sock', SP_TELEMETRY_URL: 'https://t.example', SP_TELEMETRY_CREDENTIAL: 'c',
      SP_REGION: 'westus2', SP_SUBSTRATE: 'vm',
    });
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      launch: 'podman', idleMs: 600_000, poolSize: 0, sweepAgeMs: 60_000, version: 'abc123', image: 'ghcr.io/x/y:1', imageAbi: '3',
      runnerUser: 'agent', runnerPath: '/usr/bin:/bin', modelProxy: '/run/p/control.sock', modelSocket: '/run/p/api.sock',
      telemetry: { url: 'https://t.example', credential: 'c', region: 'westus2', substrate: 'vm' },
    });
  });

  it('warns and keeps the default for numbers that are not (no more NaN)', () => {
    for (const [name, value] of [['SP_IDLE_MS', 'two hours'], ['SP_IDLE_MS', '0'], ['SP_IDLE_MS', '-5'], ['SP_POOL_SIZE', 'lots'], ['SP_POOL_SIZE', '1.5'], ['SP_POOL_SIZE', '-1']]) {
      const { config, warnings } = load({ [name]: value });
      expect(config.idleMs).toBe(IDLE_MS);
      expect(config.poolSize).toBe(POOL_SIZE);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${name}=${value}`);
    }
    const sweep = load({ SP_SWEEP_AGE_MS: '0' });
    expect(sweep.config.sweepAgeMs).toBeUndefined();
    expect(sweep.warnings[0]).toContain('SP_SWEEP_AGE_MS=0');
  });

  it('warns and keeps the platform default for an unknown launch mode', () => {
    const { config, warnings } = load({ SP_LAUNCH: 'docker' });
    expect(config.launch).toBe('systemd');
    expect(warnings[0]).toMatch(/SP_LAUNCH=docker is not systemd, podman or detached/);
  });

  it('raises the memory cap with SP_RUNNER_MEMORY_MAX, still at most 75% of RAM', () => {
    expect(load({ SP_RUNNER_MEMORY_MAX: '32G' }, 128 * GIB).config).toMatchObject({
      runnerMemoryMax: 32 * GIB, systemdRun: 'systemd-run --user --slice=slack-presence-runners.slice -p MemoryHigh=24G -p MemoryMax=32G',
    });
    expect(load({ SP_RUNNER_MEMORY_MAX: '64G' }, 32 * GIB).config.systemdRun).toContain('-p MemoryMax=24G');
  });

  it('warns and keeps 16G for a memory cap that is not one', () => {
    for (const v of ['lots', '0', '-8G', '512M']) {
      const { config, warnings } = load({ SP_RUNNER_MEMORY_MAX: v });
      expect(config.runnerMemoryMax).toBe(16 * GIB);
      expect(config.systemdRun).toContain('MemoryMax=16G');
      expect(warnings).toEqual([expect.stringContaining(`SP_RUNNER_MEMORY_MAX=${v}`)]);
    }
  });

  it('lets SP_SYSTEMD_RUN replace the prefix, and says when it hides SP_RUNNER_MEMORY_MAX', () => {
    expect(load({ SP_SYSTEMD_RUN: 'systemd-run --user' })).toEqual(expect.objectContaining({ warnings: [] }));
    const { config, warnings } = load({ SP_SYSTEMD_RUN: ' systemd-run --user -p MemoryMax=8G ', SP_RUNNER_MEMORY_MAX: '32G' });
    expect(config.systemdRun).toBe('systemd-run --user -p MemoryMax=8G');
    expect(warnings).toEqual([expect.stringMatching(/SP_RUNNER_MEMORY_MAX is ignored/)]);
  });

  it('throws only where there is no default: a podman host without its user, image or ABI', () => {
    expect(() => load(PODMAN)).not.toThrow();
    expect(() => load({ ...PODMAN, SP_RUNNER_USER: '' })).toThrow(/needs a runner user/);
    expect(() => load({ ...PODMAN, SP_IMAGE: undefined })).toThrow(/needs SP_IMAGE and SP_IMAGE_ABI/);
    expect(() => load({ ...PODMAN, SP_IMAGE_ABI: '' })).toThrow(/needs SP_IMAGE and SP_IMAGE_ABI/);
    // Identity is not required here (identity.ts has its defaults and saved file), and neither is anything else.
    expect(() => load({ SP_GATEWAY_URL: undefined, SP_HOST_TOKEN: undefined, SP_IDLE_MS: 'x', SP_LAUNCH: 'x' })).not.toThrow();
  });
});
