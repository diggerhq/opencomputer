import { beforeAll, describe, expect, it } from 'vitest';
import { tbTime, uuidv7 } from '../../../src/telemetry/envelope.js';
import { digest, digestKey } from './batch.js';
import { generateKeys, sign } from './credential.js';
import { type Env, handle, MAX_BODY_BYTES } from './handler.js';

const NOW = Date.UTC(2030, 0, 1);
let keys: Awaited<ReturnType<typeof generateKeys>>;
let token: string;
let env: Env;

beforeAll(async () => {
  keys = await generateKeys();
  token = await sign({ org_id: 'org_1', host_id: 'host-a', exp: NOW / 1000 + 3600 }, keys.privateKey);
  env = {
    TINYBIRD_API_URL: 'https://tb.example/',
    TINYBIRD_APPEND_TOKEN: 'p.append',
    REPO_DIGEST_KEY: 'digest-secret',
    CREDENTIAL_PUBLIC_KEY: keys.publicKey,
    VERSION: 'abc1234',
  };
});

const event = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  event_id: uuidv7(NOW),
  event_name: 'fork.repo',
  occurred_at: tbTime(NOW),
  service_name: 'host',
  service_version: '1.0.0',
  region: 'westus2',
  synthetic: false,
  trace_id: uuidv7(NOW),
  session_key: 'T1:C1:1.2',
  duration_ms: 120,
  data: { repo: 'opencomputer', fetch_ms: 100 },
  ...over,
});
const turn = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  turn_id: uuidv7(NOW),
  trace_id: uuidv7(NOW),
  session_key: 'T1:C1:1.2',
  sent_at: tbTime(NOW - 5000),
  region: 'westus2',
  gateway_version: 'g',
  host_version: 'h',
  runner_version: 'r',
  synthetic: false,
  outcome: 'completed',
  first_visible_ms: 2100,
  ...over,
});

interface Posted {
  url: string;
  auth: string | null;
  rows: Record<string, unknown>[];
}

/** A fake Tinybird: records each POST, answers `status`. */
function tinybird(status = 202) {
  const posted: Posted[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const rows = String(init.body)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    posted.push({ url, auth: new Headers(init.headers).get('Authorization'), rows });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  const rows = (ds: string) => posted.filter((p) => p.url.includes(`name=${ds}`)).flatMap((p) => p.rows);
  return { f, posted, rows };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://telemetry.example/v1/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const batch = (events: unknown[] = [event()], turns: unknown[] = [turn()]) => ({ host_boot_id: 'boot-1', batch_seq: 7, events, turns });

describe('collector', () => {
  it('forwards a valid batch to both datasources with the collector token', async () => {
    const tb = tinybird();
    const res = await handle(post(batch()), env, tb.f, NOW);
    expect(res.status).toBe(200);
    expect(tb.posted.map((p) => p.url).sort()).toEqual([
      'https://tb.example/v0/events?name=calvin_events&wait=false',
      'https://tb.example/v0/events?name=calvin_turns&wait=false',
    ]);
    expect(tb.posted.every((p) => p.auth === 'Bearer p.append')).toBe(true);
    expect(tb.rows('calvin_turns')).toHaveLength(1);
    expect(typeof tb.rows('calvin_events')[0].data).toBe('string');
  });

  it('overwrites a forged org_id and host_id from the credential', async () => {
    const tb = tinybird();
    await handle(post(batch([event({ org_id: 'org_victim', host_id: 'host-z' })], [turn({ org_id: 'org_victim' })])), env, tb.f, NOW);
    for (const r of [...tb.rows('calvin_events'), ...tb.rows('calvin_turns')]) {
      expect(r.org_id).toBe('org_1');
      expect(r.host_id).toBe('host-a');
    }
  });

  it('replaces repository names with the keyed digest', async () => {
    const tb = tinybird();
    await handle(post(batch([event(), event({ event_name: 'housekeeping.fetch', data: { repo: 'opencomputer' } })], [])), env, tb.f, NOW);
    const want = await digest(await digestKey('digest-secret'), 'opencomputer');
    expect(want).toMatch(/^[0-9a-f]{12}$/);
    const repos = tb.rows('calvin_events').map((r) => JSON.parse(r.data as string).repo).filter(Boolean);
    expect(repos).toEqual([want, want]);
    expect(JSON.stringify(tb.posted)).not.toContain('opencomputer');
  });

  it('records the batch sequence number for gap detection', async () => {
    const tb = tinybird();
    await handle(post(batch()), env, tb.f, NOW);
    const b = tb.rows('calvin_events').find((r) => r.event_name === 'telemetry.batch')!;
    expect(b.service_name).toBe('collector');
    expect(b.host_id).toBe('host-a');
    expect(JSON.parse(b.data as string)).toEqual({ host_boot_id: 'boot-1', batch_seq: 7, events: 1, turns: 1, dropped: 0 });
  });

  it.each([
    ['a Slack token', event({ data: { repo: 'xoxb-1-2-3' } })],
    ['an Authorization header', event({ error_code: 'Bearer abc' })],
    ['a path', event({ data: { repo: '/home/agent/ws/secret' } })],
    ['an oversized field', event({ tool_name: 'x'.repeat(300) })],
    ['a runner event claiming to be the collector', event({ service_name: 'collector', event_name: 'turn.ended', data: {} })],
    [
      'a forged batch record',
      event({ service_name: 'collector', event_name: 'telemetry.batch', data: { host_boot_id: 'boot-1', batch_seq: 6 } }),
    ],
  ])('drops and counts %s, forwarding the rest', async (_, bad) => {
    const tb = tinybird();
    const res = await handle(post(batch([bad, event()], [])), env, tb.f, NOW);
    expect(await res.json()).toMatchObject({ invalid: 1 });
    const names = tb.rows('calvin_events').map((r) => r.event_name);
    expect(names.sort()).toEqual(['fork.repo', 'telemetry.batch', 'telemetry.dropped']);
    const dropped = tb.rows('calvin_events').find((r) => r.event_name === 'telemetry.dropped')!;
    expect(JSON.parse(dropped.data as string)).toEqual({ reason: 'invalid', count: 1 });
  });

  it('drops an invalid turn row and counts it', async () => {
    const tb = tinybird();
    const res = await handle(post(batch([], [turn({ outcome: 'exploded' }), turn()])), env, tb.f, NOW);
    expect(await res.json()).toMatchObject({ turns: 1, invalid: 1 });
  });

  it.each([
    ['no credential', {}],
    ['a garbage credential', { Authorization: 'Bearer v1.x.y' }],
  ])('rejects %s with 401', async (_, headers) => {
    const tb = tinybird();
    const req = new Request('https://telemetry.example/v1/events', { method: 'POST', headers, body: JSON.stringify(batch()) });
    expect((await handle(req, env, tb.f, NOW)).status).toBe(401);
    expect(tb.posted).toHaveLength(0);
  });

  it('rejects an expired credential with 401', async () => {
    const old = await sign({ org_id: 'org_1', host_id: 'host-a', exp: NOW / 1000 - 1 }, keys.privateKey);
    expect((await handle(post(batch(), { Authorization: `Bearer ${old}` }), env, tinybird().f, NOW)).status).toBe(401);
  });

  it('rejects a credential signed by another key with 401', async () => {
    const other = await generateKeys();
    const forged = await sign({ org_id: 'org_1', host_id: 'host-a', exp: NOW / 1000 + 60 }, other.privateKey);
    expect((await handle(post(batch(), { Authorization: `Bearer ${forged}` }), env, tinybird().f, NOW)).status).toBe(401);
  });

  it('rejects a denylisted host with 401', async () => {
    expect((await handle(post(batch()), { ...env, CREDENTIAL_DENYLIST: 'host-a' }, tinybird().f, NOW)).status).toBe(401);
  });

  it('answers 503 when Tinybird fails, so the host keeps the batch', async () => {
    for (const status of [500, 503, 429, 401]) {
      expect((await handle(post(batch()), env, tinybird(status).f, NOW)).status).toBe(503);
    }
    const throwing = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect((await handle(post(batch()), env, throwing, NOW)).status).toBe(503);
  });

  it('answers 429 when the host is over its rate', async () => {
    const limited = { ...env, RATE_LIMITER: { limit: async ({ key }: { key: string }) => ({ success: key !== 'host-a' }) } };
    const tb = tinybird();
    const res = await handle(post(batch()), limited, tb.f, NOW);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(tb.posted).toHaveLength(0);
  });

  it.each([
    ['not JSON', '{'],
    ['no boot id', { batch_seq: 1, events: [] }],
    ['a negative sequence', { host_boot_id: 'b', batch_seq: -1, events: [] }],
    ['too many records', { host_boot_id: 'b', batch_seq: 1, events: Array(1001).fill({}) }],
  ])('rejects %s with 400', async (_, body) => {
    expect((await handle(post(body), env, tinybird().f, NOW)).status).toBe(400);
  });

  it('rejects an oversized body with 413', async () => {
    const big = JSON.stringify(batch([{ pad: 'x'.repeat(MAX_BODY_BYTES) }], []));
    expect((await handle(post(big), env, tinybird().f, NOW)).status).toBe(413);
  });

  it('accepts and discards when telemetry is off (no append token)', async () => {
    const tb = tinybird();
    const res = await handle(post(batch()), { ...env, TINYBIRD_APPEND_TOKEN: undefined }, tb.f, NOW);
    expect(res.status).toBe(202);
    expect(tb.posted).toHaveLength(0);
  });

  it('answers 503 when the token is set but the rest is not', async () => {
    expect((await handle(post(batch()), { ...env, REPO_DIGEST_KEY: undefined }, tinybird().f, NOW)).status).toBe(503);
  });

  it('serves a health check and nothing else', async () => {
    expect((await handle(new Request('https://t.example/healthz'), env, tinybird().f, NOW)).status).toBe(200);
    expect((await handle(new Request('https://t.example/v1/other', { method: 'POST' }), env, tinybird().f, NOW)).status).toBe(404);
    expect((await handle(new Request('https://t.example/v1/events'), env, tinybird().f, NOW)).status).toBe(405);
  });
});
