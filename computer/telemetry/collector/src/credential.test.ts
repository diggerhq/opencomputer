import { describe, expect, it } from 'vitest';
import { generateKeys, parseDenylist, sign, verify } from './credential.js';

const NOW = 1_800_000_000;
const claims = { org_id: 'org_1', host_id: 'host-a', exp: NOW + 3600 };

describe('verify', () => {
  it('accepts a credential signed by a configured key', async () => {
    const k = await generateKeys();
    expect(await verify(await sign(claims, k.privateKey), k.publicKey, NOW, new Set())).toEqual(claims);
  });

  it('accepts any of several keys, so the signing key rotates without a gap', async () => {
    const [old, next] = [await generateKeys(), await generateKeys()];
    expect(await verify(await sign(claims, old.privateKey), `${next.publicKey},${old.publicKey}`, NOW, new Set())).toEqual(claims);
  });

  it.each([
    ['expired', { ...claims, exp: NOW - 1 }],
    ['missing exp', { org_id: 'org_1', host_id: 'host-a' }],
    ['a malformed host id', { ...claims, host_id: 'a/b' }],
  ])('rejects %s', async (_, c) => {
    const k = await generateKeys();
    expect(await verify(await sign(c as typeof claims, k.privateKey), k.publicKey, NOW, new Set())).toBeUndefined();
  });

  it('rejects a credential signed by another key', async () => {
    const [ours, theirs] = [await generateKeys(), await generateKeys()];
    expect(await verify(await sign(claims, theirs.privateKey), ours.publicKey, NOW, new Set())).toBeUndefined();
  });

  it('rejects edited claims under a valid signature', async () => {
    const k = await generateKeys();
    const [v, , sig] = (await sign(claims, k.privateKey)).split('.');
    const forged = btoa(JSON.stringify({ ...claims, org_id: 'org_2' })).replace(/=+$/, '');
    expect(await verify(`${v}.${forged}.${sig}`, k.publicKey, NOW, new Set())).toBeUndefined();
  });

  it.each(['', 'v1', 'v1.a.b', 'v2.x.y', 'not a token', 'v1.%%%.%%%'])('rejects garbage %j without throwing', async (t) => {
    const k = await generateKeys();
    expect(await verify(t, k.publicKey, NOW, new Set())).toBeUndefined();
  });

  it('rejects denylisted hosts and organizations', async () => {
    const k = await generateKeys();
    const t = await sign(claims, k.privateKey);
    expect(await verify(t, k.publicKey, NOW, parseDenylist('host-a'))).toBeUndefined();
    expect(await verify(t, k.publicKey, NOW, parseDenylist(' other , org:org_1 '))).toBeUndefined();
    expect(await verify(t, k.publicKey, NOW, parseDenylist('org:org_2,host-b'))).toEqual(claims);
  });
});
