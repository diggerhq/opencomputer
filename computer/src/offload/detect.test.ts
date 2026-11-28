import { describe, expect, it } from 'vitest';
import { checkAwsResult, detectAws } from './detect.js';

const DOC = { accountId: '123456789012', region: 'us-east-1', instanceId: 'i-0abc12345def67890' };

/** A fake IMDS: `doc` the identity document, `role` the role listing (undefined: 404). */
function imds(o: { doc?: unknown; role?: string; down?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const p = new URL(url).pathname;
    calls.push(`${init?.method ?? 'GET'} ${p}`);
    if (o.down) throw new Error('connect ETIMEDOUT');
    if (p === '/latest/api/token') return new Response(init?.method === 'PUT' ? 'tok' : '', { status: init?.method === 'PUT' ? 200 : 405 });
    if ((init?.headers as Record<string, string>)?.['X-aws-ec2-metadata-token'] !== 'tok') return new Response('', { status: 401 });
    if (p === '/latest/dynamic/instance-identity/document') return new Response(JSON.stringify(o.doc ?? DOC));
    if (p === '/latest/meta-data/iam/security-credentials/') return o.role ? new Response(`${o.role}\n`) : new Response('', { status: 404 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
const dmi = (vendor?: string) => (n: string) => (n === 'sys_vendor' ? vendor : undefined);

describe('detectAws', () => {
  it('Azure, GCP and bare metal are vetoed by DMI without asking IMDS', async () => {
    for (const v of ['Microsoft Corporation', 'Google', 'Dell Inc.']) {
      const m = imds({ role: 'r' });
      const r = await detectAws({ dmi: dmi(v), fetch: m.f });
      expect(r).toMatchObject({ aws: false });
      expect(checkAwsResult(r).code).toBe(1);
      expect(m.calls).toEqual([]);
    }
  });
  it('no metadata service is not AWS', async () => {
    const r = await detectAws({ dmi: dmi(undefined), fetch: imds({ down: true }).f });
    expect(checkAwsResult(r)).toMatchObject({ code: 1 });
  });
  it('a metadata look-alike is not AWS', async () => {
    const r = await detectAws({ dmi: dmi(undefined), fetch: imds({ doc: { accountId: 'x', region: 'local', instanceId: 'vm-1' }, role: 'r' }).f });
    expect(r).toEqual({ aws: false, why: 'instance identity document is not an EC2 one' });
  });
  it('EC2 without a role exits 2', async () => {
    const r = await detectAws({ dmi: dmi('Amazon EC2'), fetch: imds().f });
    expect(r).toEqual({ aws: true, ...DOC });
    expect(checkAwsResult(r).code).toBe(2);
  });
  it('EC2 with a role exits 0, IMDSv2 only, credentials never fetched', async () => {
    const m = imds({ role: 'offload-role' });
    const r = await detectAws({ dmi: dmi('Amazon EC2'), fetch: m.f });
    expect(r).toEqual({ aws: true, role: 'offload-role', ...DOC });
    expect(checkAwsResult(r)).toMatchObject({ code: 0 });
    expect(m.calls).toEqual(['PUT /latest/api/token', 'GET /latest/dynamic/instance-identity/document', 'GET /latest/meta-data/iam/security-credentials/']);
  });
});
