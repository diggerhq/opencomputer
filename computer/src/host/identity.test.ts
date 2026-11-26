import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignedIdentity, identityFile, loadIdentity, saveIdentity } from './identity.js';

const env = { SP_GATEWAY_URL: 'wss://gw.example/v1/computer/host?organizationId=pool-a1', SP_HOST_TOKEN: 'sph_pool', SP_HOST_ID: 'pool-a1' };
const pool = { gatewayUrl: env.SP_GATEWAY_URL, token: 'sph_pool', hostId: 'pool-a1' };
const assign = { organizationId: 'org_1', hostToken: 'sph_org', gatewayUrl: 'wss://gw.example/v1/computer/host?organizationId=org_1' };

describe('host identity', () => {
  it('uses the environment until an identity is saved, then the saved one', () => {
    const file = identityFile(mkdtempSync(path.join(os.tmpdir(), 'id-')));
    expect(loadIdentity(env, file, 'h')).toEqual(pool);
    saveIdentity(file, { gatewayUrl: assign.gatewayUrl, token: 'sph_org', hostId: 'org_1' });
    expect(loadIdentity(env, file, 'h')).toEqual({ gatewayUrl: assign.gatewayUrl, token: 'sph_org', hostId: 'org_1' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('ignores a damaged saved identity', () => {
    const file = identityFile(mkdtempSync(path.join(os.tmpdir(), 'id-')));
    saveIdentity(file, pool);
    writeFileSync(file, '{not json');
    expect(loadIdentity(env, file, 'h')).toEqual(pool);
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });

  it('lets a pool host become an organization on the same gateway', () => {
    expect(assignedIdentity(pool, assign)).toEqual({ gatewayUrl: assign.gatewayUrl, token: 'sph_org', hostId: 'org_1' });
  });

  it('never reassigns an organization, or moves a host to another gateway', () => {
    expect(assignedIdentity({ ...pool, hostId: 'org_9' }, assign)).toHaveProperty('error');
    expect(assignedIdentity(pool, { ...assign, gatewayUrl: 'wss://evil.example/x' })).toHaveProperty('error');
    expect(assignedIdentity(pool, { ...assign, gatewayUrl: 'ws://gw.example/x' })).toHaveProperty('error');
    expect(assignedIdentity(pool, { ...assign, organizationId: 'pool-b2' })).toHaveProperty('error');
    expect(assignedIdentity(pool, { ...assign, hostToken: '' })).toHaveProperty('error');
  });
});
