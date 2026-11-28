// Is this box an EC2 instance with an instance role (work 136)? `check-aws`
// asks before the service starts; its exit code is the answer:
//   0 AWS with a role, 1 not AWS, 2 AWS without a role.
//
// Invariants:
// - DMI vetoes first: a box whose firmware says another vendor (Azure, GCP,
//   bare metal) is not AWS, and IMDS is never asked. Without DMI (a container)
//   IMDS decides.
// - IMDSv2 only (token PUT, then GETs with the token); every call times out
//   in 1 s. The identity document must look like one (accountId, region,
//   instanceId i-…), so a metadata look-alike on 169.254.169.254 is not AWS.
// - Role credentials are never fetched: only the role's name is listed.
//   Nothing printed carries a credential.

export const IMDS = 'http://169.254.169.254';

export type Detected =
  | { aws: true; role: string; region: string; accountId: string; instanceId: string }
  | { aws: true; role?: undefined; region: string; accountId: string; instanceId: string }
  | { aws: false; why: string };

export interface DetectDeps {
  /** A DMI file's text, trimmed, or undefined when it cannot be read. */
  dmi(name: 'sys_vendor' | 'product_name' | 'bios_vendor' | 'board_vendor'): string | undefined;
  fetch: typeof fetch;
  imds?: string;
}

const AWS_DMI = /amazon/i;

export async function detectAws(d: DetectDeps): Promise<Detected> {
  const vendors = (['sys_vendor', 'bios_vendor', 'board_vendor'] as const).map((n) => d.dmi(n)).filter((v): v is string => !!v);
  if (vendors.length && !vendors.some((v) => AWS_DMI.test(v))) return { aws: false, why: `firmware vendor is ${vendors[0]}` };
  const base = d.imds ?? IMDS;
  const call = async (p: string, init: RequestInit = {}) => {
    const res = await d.fetch(`${base}${p}`, { ...init, signal: AbortSignal.timeout(1000) });
    return { status: res.status, text: await res.text() };
  };
  let token: string;
  try {
    const t = await call('/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' } });
    if (t.status !== 200 || !t.text) return { aws: false, why: `IMDSv2 token request answered ${t.status}` };
    token = t.text;
  } catch {
    return { aws: false, why: 'no instance metadata service' };
  }
  const h = { headers: { 'X-aws-ec2-metadata-token': token } };
  let doc: { accountId?: unknown; region?: unknown; instanceId?: unknown };
  try {
    const r = await call('/latest/dynamic/instance-identity/document', h);
    doc = r.status === 200 ? JSON.parse(r.text) : {};
  } catch {
    doc = {};
  }
  const { accountId, region, instanceId } = doc;
  if (typeof accountId !== 'string' || !/^\d{12}$/.test(accountId) || typeof region !== 'string' || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)
    || typeof instanceId !== 'string' || !/^i-[0-9a-f]{8,}$/.test(instanceId))
    return { aws: false, why: 'instance identity document is not an EC2 one' };
  try {
    const r = await call('/latest/meta-data/iam/security-credentials/', h);
    const role = r.status === 200 ? r.text.split('\n').map((l) => l.trim()).find(Boolean) : undefined;
    if (role) return { aws: true, role, region, accountId, instanceId };
  } catch {}
  return { aws: true, region, accountId, instanceId };
}

/** `check-aws`'s exit code and its one line. */
export function checkAwsResult(r: Detected): { code: 0 | 1 | 2; line: string } {
  if (!r.aws) return { code: 1, line: `not AWS: ${r.why}` };
  if (!r.role) return { code: 2, line: `AWS ${r.region} (${r.instanceId}) without an instance role: attach the offload role (selfhost/aws/offload.yaml)` };
  return { code: 0, line: `AWS ${r.region} (${r.instanceId}), instance role ${r.role}` };
}
