// A WebClient stand-in that prints every API call (any method path) and
// answers ok. Used by the runner under SP_FAKE_SLACK=1 and by dev scripts.

import type { WebClient } from '@slack/web-api';

export function fakeSlack(print: (line: string) => void = console.log): WebClient {
  const t0 = Date.now();
  let n = 0;
  const short = (a: any) => {
    const s = JSON.stringify(a, (k, v) => (k === 'blocks' ? `[${v.length} blocks]` : v)) ?? '';
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  };
  const node = (names: string[]): any =>
    new Proxy(() => {}, {
      get: (_, k) => (k === 'then' ? undefined : k === 'token' ? 'xoxb-fake' : node([...names, String(k)])),
      apply: async (_, __, [args]) => {
        const method = names.join('.');
        print(`+${((Date.now() - t0) / 1000).toFixed(1)}s slack ${method} ${short(args)}`);
        if (method === 'users.info') return { ok: true, user: { profile: { display_name: `tester-${args?.user}` } } };
        if (method === 'conversations.info') return { ok: true, channel: { id: args?.channel, name: 'fake-channel' } };
        return { ok: true, ts: `1.${++n}`, channel_id: 'C_FAKE' };
      },
    });
  return node([]);
}
