import { describe, expect, it } from 'vitest';
import { apiRelay, type WireHooks, type WireLinkLike } from './api-relay.js';

function link(calls: string[]): WireLinkLike {
  return {
    setKey: (k) => void calls.push(`key ${k}`),
    setAccess: (a) => void calls.push(`access ${a.sessionId}`),
    setAdmins: (a) => void calls.push(`admins ${a.join(',')}`),
    revoked: (id) => void calls.push(`revoked ${id}`),
    moved: (s) => void calls.push(`moved ${s}`),
    close: async () => void calls.push('close'),
  };
}

const hooks = {} as WireHooks;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('apiRelay', () => {
  it('gives a link that comes up everything the host was told before it, then each change', async () => {
    const calls: string[] = [];
    const relay = apiRelay(async () => link(calls), hooks);
    relay.welcome('k1');
    relay.people([{ userId: 'usr_a', admin: true } as never, { userId: 'usr_b' } as never]);
    relay.access({ sessionId: 'cs_1', owner: 'usr_a', members: null });
    relay.moved('cs_1'); // no link yet: nothing to tell
    relay.start();
    await settle();
    expect(calls).toEqual(['key k1', 'admins usr_a', 'access cs_1']);
    relay.revoked('key_1');
    relay.moved('cs_1');
    await relay.close();
    expect(calls.slice(3)).toEqual(['revoked key_1', 'moved cs_1', 'close']);
  });

  it('keeps its key across a keyless welcome, and takes a later previews key', async () => {
    const calls: string[] = [];
    const relay = apiRelay(async () => link(calls), hooks);
    relay.start();
    await settle();
    relay.welcome(undefined);
    relay.previews('k1');
    relay.welcome(undefined);
    relay.welcome('k2');
    relay.previews('k2');
    expect(calls.filter((c) => c.startsWith('key'))).toEqual(['key null', 'key k1', 'key k2']);
  });

  it('starts once, and tries again after a start that failed', async () => {
    let n = 0;
    const relay = apiRelay(async () => {
      if (++n === 1) throw new Error('no socket');
      return link([]);
    }, hooks);
    relay.start();
    relay.start(); // still starting
    await settle();
    expect(n).toBe(1);
    relay.start();
    await settle();
    relay.start(); // up
    expect(n).toBe(2);
  });
});
