import { expect, it } from 'vitest';
import { forward } from './tinybird.js';

it('calls fetch unbound, as Workers require', async () => {
  // Workers' global fetch throws "Illegal invocation" when `this` is anything else.
  const strict = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(new Response('{}'));
  } as unknown as typeof fetch;
  const event = { schema_version: 1, event_id: 'e', event_name: 'telemetry.batch', occurred_at: '2026-10-13 00:00:00.000', service_name: 'collector', service_version: 'dev', region: 'x', synthetic: false, data: {} };
  expect(await forward({ url: 'https://tb.example', token: 't', fetch: strict }, [event as never], [])).toBe(true);
});
