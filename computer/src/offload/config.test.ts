import { describe, expect, it } from 'vitest';
import { loadOffloadConfig } from './config.js';

const base = { SP_OFFLOAD_BACKEND: 'aws-microvm', SP_OFFLOAD_BUCKET: 'b', SP_OFFLOAD_IMAGE_S: 'img-s', SP_OFFLOAD_IMAGE_M: 'img-m' };

describe('loadOffloadConfig', () => {
  it('reads nothing without the enable marker', () => {
    const l = loadOffloadConfig(base, false);
    expect(l.config).toBeUndefined();
    expect(l.off).toMatch(/not enabled/);
  });
  it('accepts aws-microvm only, SP_OFFLOAD as alias', () => {
    expect(loadOffloadConfig({ ...base, SP_OFFLOAD_BACKEND: undefined, SP_OFFLOAD: 'aws-microvm' }, true).config).toBeDefined();
    const other = loadOffloadConfig({ ...base, SP_OFFLOAD_BACKEND: 'gcp' }, true);
    expect(other.config).toBeUndefined();
    expect(other.warnings[0]).toMatch(/only aws-microvm/);
    expect(loadOffloadConfig({ ...base, SP_OFFLOAD_BACKEND: '' }, true).config).toBeUndefined();
  });
  it('defaults, and warns for bad tunables', () => {
    const c = loadOffloadConfig(base, true).config!;
    expect(c).toMatchObject({ maxConcurrent: 2, queueMax: 4, maxMinutes: 60, sourceMaxMb: 2048, artifactMaxMb: 2048, images: { s: 'img-s', m: 'img-m' } });
    const l = loadOffloadConfig({ ...base, SP_OFFLOAD_MAX_CONCURRENT: 'x', SP_OFFLOAD_MAX_MINUTES: '9999' }, true);
    expect(l.config).toMatchObject({ maxConcurrent: 2, maxMinutes: 480 });
    expect(l.warnings).toHaveLength(2);
  });
  it('is off without a bucket or any image; one image is a warning', () => {
    expect(loadOffloadConfig({ ...base, SP_OFFLOAD_BUCKET: '' }, true).off).toMatch(/BUCKET/);
    expect(loadOffloadConfig({ ...base, SP_OFFLOAD_IMAGE_S: '', SP_OFFLOAD_IMAGE_M: '' }, true).off).toMatch(/IMAGE/);
    const l = loadOffloadConfig({ ...base, SP_OFFLOAD_IMAGE_M: '' }, true);
    expect(l.config?.images).toEqual({ s: 'img-s' });
    expect(l.warnings[0]).toMatch(/size m is refused/);
  });
});
