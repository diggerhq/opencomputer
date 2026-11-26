import { describe, expect, it } from 'vitest';
import { CloudError, cloudApi } from './cloud.js';

function rig(replies: Array<{ status: number; body?: unknown }>, expiresIn = 3_600_000) {
  const asked: Array<{ url: string; init: any }> = [];
  let keys = 0;
  const api = cloudApi({
    now: () => 0,
    key: async () => ({ token: `k${++keys}`, expiresAt: new Date(expiresIn).toISOString(), apiUrl: 'https://api.test/' }),
    fetch: (async (url: URL, init: any) => {
      asked.push({ url: String(url), init });
      const r = replies.shift()!;
      return new Response(r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
    }) as never,
  });
  return { api, asked, keys: () => keys };
}

describe('cloudApi', () => {
  it("calls the public API with the session's key, the query, the body and the Idempotency-Key", async () => {
    const t = rig([{ status: 200, body: { ok: 1 } }, { status: 200, body: {} }]);
    expect(await t.api.call('POST', '/sessions', { body: { input: 'x' }, query: { a: 1, b: undefined }, key: 'toolu_1' })).toEqual({ ok: 1 });
    expect(t.asked[0].url).toBe('https://api.test/api/managed-agents/computer/sessions?a=1');
    expect(t.asked[0].init).toMatchObject({ method: 'POST', body: '{"input":"x"}', headers: { authorization: 'Bearer k1', 'content-type': 'application/json', 'idempotency-key': 'toolu_1' } });
    await t.api.call('GET', '/work/overview');
    expect(t.keys()).toBe(1); // the key is held until it nears its end
  });

  it('asks for a new key when the held one nears its end, and once after a 401', async () => {
    const soon = rig([{ status: 200, body: {} }, { status: 200, body: {} }], 4 * 60_000);
    await soon.api.call('GET', '/a');
    await soon.api.call('GET', '/a');
    expect(soon.keys()).toBe(2);
    const t = rig([{ status: 401, body: { error: { code: 'unauthorized' } } }, { status: 200, body: { ok: true } }]);
    expect(await t.api.call('GET', '/a')).toEqual({ ok: true });
    expect(t.asked.map((a) => a.init.headers.authorization)).toEqual(['Bearer k1', 'Bearer k2']);
  });

  it("an error is the API's code, message and reason", async () => {
    const t = rig([{ status: 409, body: { error: { code: 'refused', message: 'Refused: refused.', reason: 'user_set' } } }]);
    const e = await t.api.call('PUT', '/work/threads/cs_1/title', { body: {} }).catch((x) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ status: 409, code: 'refused', reason: 'user_set' });
  });

  it('a reply that is not JSON is an error, never an empty answer', async () => {
    // An app origin's page fallback answers a GET with HTML and a PUT with a bare 405.
    const t = rig([{ status: 200, body: '<!doctype html><html></html>' }, { status: 405, body: 'Method Not Allowed' }]);
    await expect(t.api.call('GET', '/feed')).rejects.toMatchObject({ status: 200, code: 'http_200' });
    await expect(t.api.call('PUT', '/work/tracks/trk_1/stand', { body: { stand: 'x' } })).rejects.toMatchObject({ status: 405, code: 'http_405' });
  });
});
