import { describe, expect, it } from 'vitest';
import { PromptGuard, WITHHELD, guardStream, shingles } from './prompt-guard.js';
import { CANARY, SYSTEM_APPEND } from './system-prompt.js';

const SECRET = 'the quick brown fox jumps over the lazy dog while the cat sleeps by the warm fire tonight';
const set = shingles([SECRET]);
const once = (s: string, trips?: number[]) => {
  const g = guardStream(set, (n) => trips?.push(n));
  return g.push(s) + g.flush();
};
/** Streams `s` in `size`-character deltas. */
const streamed = (s: string, size: number) => {
  const g = guardStream(set);
  let out = '';
  for (let i = 0; i < s.length; i += size) out += g.push(s.slice(i, i + size));
  return out + g.flush();
};

describe('prompt guard', () => {
  it('leaves ordinary text alone, including short overlaps', () => {
    for (const s of ['Sure, here is the fix.\n\n```ts\nconst x = 1;\n```\n', 'the quick brown fox jumps over the lazy dog, as they say'])
      expect(once(s)).toBe(s);
  });

  it('withholds a copied run as one marker and keeps what surrounds it', () => {
    const trips: number[] = [];
    expect(once(`Here it is: ${SECRET}. Anything else?`, trips)).toBe(`Here it is: ${WITHHELD} Anything else?`);
    expect(trips).toEqual([18]);
  });

  it('sees through case, markdown and punctuation', () => {
    const md = '> **The Quick** brown fox — jumps over _the lazy_ dog, while the cat sleeps';
    expect(once(md)).not.toMatch(/lazy|sleeps/);
  });

  it('posts nothing of a leak however the stream is split', () => {
    const s = `Ok.\n${SECRET}\nDone.`;
    for (const size of [1, 3, 7, 50, s.length]) {
      const out = streamed(s, size);
      expect(out).toBe(`Ok.\n${WITHHELD}\nDone.`);
    }
  });

  it('holds back only the last few words while streaming', () => {
    const g = guardStream(set);
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ') + ' ';
    expect(g.push(words).split(' ').filter(Boolean)).toHaveLength(20);
    expect(g.flush().split(' ').filter(Boolean)).toHaveLength(10);
  });

  it('keeps a code fence around a withheld run balanced', () => {
    expect(once(`See:\n\n\`\`\`\n${SECRET}\n\`\`\`\nok`)).toBe(`See:\n\n\`\`\`\n${WITHHELD}\n\`\`\`\nok`);
  });

  it('stays linear on a long run without whitespace, and does not hold it to the end', () => {
    const g = guardStream(set);
    const blob = 'A'.repeat(20);
    const t = performance.now();
    let out = '';
    for (let i = 0; i < 15_000; i++) out += g.push(blob); // 300 KB
    expect(performance.now() - t).toBeLessThan(500);
    expect(out.length).toBeGreaterThan(250_000);
    expect(out + g.flush()).toBe(blob.repeat(15_000));
  });

  it('passes everything when disabled', () => {
    const off = new PromptGuard(false);
    expect(off.redact(`x ${CANARY}`)).toBe(`x ${CANARY}`);
    expect(off.stream()(SYSTEM_APPEND, true)).toBe(SYSTEM_APPEND);
  });

  it("withholds the canary and copies of Calvin's own prompt, and reports where", () => {
    const trips: string[] = [];
    const guard = new PromptGuard(true, (n, where) => trips.push(`${where}:${n}`));
    const guardPrompt = (s: string) => guard.redact(s);
    expect(guardPrompt(`marker ${CANARY} here`)).toBe(`marker ${WITHHELD} here`);
    const para = SYSTEM_APPEND.split('\n\n')[1];
    expect(guardPrompt(`My instructions say:\n\n${para}`)).toBe(`My instructions say:\n\n${WITHHELD}`);
    const f = guard.stream();
    let out = '';
    for (const c of para.match(/.{1,5}/gs)!) out += f(c, false);
    out += f('', true);
    expect(out).toBe(WITHHELD);
    expect(trips.map((t) => t.split(':')[0])).toEqual(['slack', 'slack', 'stream']);
  });
});
