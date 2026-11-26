import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mintTicket, signPreview, signWire, verifyPreview, verifyTicket, verifyWire } from './signed-header.js';

// From the backend's preview auth: previewKey('platform-test-key', '6f1c2a5e-0000-4000-8000-000000000001'),
// then signPreview(key, 5173, 1_800_000_000_000).
const KEY = 'wvKchOLW_FTP0NokuvL3tl2OEXIXZklLRTZLhoTXXHU';
const NOW = 1_800_000_000_000;
const SIGNED = '1800000060000.zjnjCzvyxt4qHDLXiYyNfJOWHmUBAaIOgTYJFYvFNhE';

describe('preview signature', () => {
  it('matches the backend\'s signature byte for byte', () => {
    expect(signPreview(KEY, 5173, NOW)).toBe(SIGNED);
    expect(verifyPreview(KEY, 5173, SIGNED, NOW)).toBe(true);
  });

  it('refuses another port, another key, a tampered signature and a malformed header', () => {
    expect(verifyPreview(KEY, 5174, SIGNED, NOW)).toBe(false);
    expect(verifyPreview(Buffer.alloc(32, 1).toString('base64url'), 5173, SIGNED, NOW)).toBe(false);
    expect(verifyPreview(KEY, 5173, SIGNED.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), NOW)).toBe(false);
    expect(verifyPreview(KEY, 5173, undefined, NOW)).toBe(false);
    expect(verifyPreview(KEY, 5173, `${NOW + 1000}.short`, NOW)).toBe(false);
  });

  it('refuses an expired signature and one that expires too far ahead', () => {
    expect(verifyPreview(KEY, 5173, SIGNED, NOW + 60_000)).toBe(false);
    expect(verifyPreview(KEY, 5173, SIGNED, NOW + 59_999)).toBe(true);
    // A Worker clock up to 30 s ahead of the VM's is fine; beyond that the expiry is too far ahead.
    expect(verifyPreview(KEY, 5173, signPreview(KEY, 5173, NOW + 30_000), NOW)).toBe(true);
    expect(verifyPreview(KEY, 5173, signPreview(KEY, 5173, NOW + 30_001), NOW)).toBe(false);
  });
});

// The shared vector (work 084): blue and opc reproduce the same bytes.
const V = JSON.parse(readFileSync(new URL('../schema/wire-auth-vectors.json', import.meta.url), 'utf8'));

describe('wire-auth vectors', () => {
  it('reproduces the preview header', () => {
    expect(signPreview(V.preview.key, V.preview.port, V.preview.now)).toBe(V.preview.header);
  });

  it('signs and verifies every X-Wire-Auth case, and refuses the refusals', () => {
    for (const c of V.wire.cases) {
      const { exp: _exp, ...claims } = c.claims;
      expect(signWire(V.wire.key, claims, c.now)).toEqual(c.headers);
      expect(verifyWire(V.wire.key, c.headers, c.now)).toEqual(c.claims);
      expect(verifyWire(V.wire.key, c.headers, c.now + 29_999)).toBeDefined();
    }
    for (const r of V.wire.refuse) expect(verifyWire(r.key ?? V.wire.key, r.headers, r.now), r.why).toBeUndefined();
  });

  it('mints and verifies every ticket case, and refuses the refusals', () => {
    for (const c of V.ticket.cases) {
      const { v: _v, exp: _exp, ...claims } = c.claims;
      expect(mintTicket(V.ticket.wireTicketKey, claims, c.now)).toBe(c.ticket);
      expect(verifyTicket(V.ticket.wireTicketKey, c.ticket, c.now)).toEqual(c.claims);
    }
    for (const r of V.ticket.refuse) expect(verifyTicket(V.ticket.wireTicketKey, r.ticket, r.now), r.why).toBeUndefined();
  });

  it('refuses a header repeated (an array) and a client with a pipe', () => {
    const h = V.wire.cases[0].headers;
    expect(verifyWire(V.wire.key, { ...h, 'x-wire-member': [h['x-wire-member'], 'usr_x'] }, V.wire.cases[0].now)).toBeUndefined();
    expect(() => signWire(V.wire.key, { member: 'usr_a', keyId: 'k', client: 'a|b', scope: {} })).toThrow();
  });
});
