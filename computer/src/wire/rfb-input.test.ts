import { describe, expect, it } from 'vitest';
import { rfbActivity } from './rfb-input.js';

const bytes = (...msgs: number[][]) => Uint8Array.from(msgs.flat());
const handshake = [...new TextEncoder().encode('RFB 003.008\n'), 1, 1];
const update = [3, 1, 0, 0, 0, 0, 5, 0, 3, 32];
const encodings = [2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21];
const key = [4, 1, 0, 0, 0, 0, 0, 0x61];
const pointer = [5, 1, 0, 10, 0, 20];

describe('rfbActivity', () => {
  it('skips the handshake and setup, and counts keys and the pointer, not update requests', () => {
    const seen = rfbActivity();
    expect(seen(bytes(handshake, encodings, update))).toBe(false);
    expect(seen(bytes(update, update))).toBe(false);
    expect(seen(bytes(update, pointer))).toBe(true);
    expect(seen(bytes(key))).toBe(true);
  });

  it('follows messages cut anywhere', () => {
    const all = bytes(handshake, encodings, update, [6, 0, 0, 0, 0, 0, 0, 3, 120, 121, 122], update);
    const seen = rfbActivity();
    const results = [...all].map((b) => seen(Uint8Array.of(b)));
    // Only the clipboard message's last byte completes an action.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.indexOf(true)).toBe(handshake.length + encodings.length + update.length + 10);
  });

  it('counts everything once it loses the stream', () => {
    const seen = rfbActivity();
    expect(seen(bytes(handshake, [99]))).toBe(true);
    expect(seen(bytes(update))).toBe(true);
  });
});
