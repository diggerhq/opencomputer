import { describe, expect, it } from 'vitest';
import { PREPARING_INTERVAL_MS, type PreparingData, PreparingCalls } from './preparing.js';

function world() {
  let now = 0;
  const out: PreparingData[] = [];
  const p = new PreparingCalls((d) => out.push(d), () => now, (f) => f.replace('/w/', ''));
  return { p, out, tick: (ms: number) => void (now += ms) };
}

describe('PreparingCalls (work 084 A1)', () => {
  it('names the tool at once, then its path and the lines written so far, at most once per interval', () => {
    const { p, out, tick } = world();
    p.start('tu1', 'Write');
    expect(out).toEqual([{ subagentId: null, callId: 'tu1', toolName: 'Write', path: null, description: null, lines: null }]);
    p.input('tu1', '{"file_path":"/w/src/');
    tick(PREPARING_INTERVAL_MS);
    p.input('tu1', 'x.ts","content":"a\\nb');
    expect(out.at(-1)).toMatchObject({ path: 'src/x.ts', lines: 2 });
    p.input('tu1', '\\nc\\n');
    expect(out).toHaveLength(2); // throttled
    tick(PREPARING_INTERVAL_MS);
    p.input('tu1', 'd');
    expect(out.at(-1)).toMatchObject({ lines: 4 }); // the change held back goes with the next input after the interval
    tick(PREPARING_INTERVAL_MS);
    p.input('tu1', '\\');
    p.input('tu1', 'ne"}');
    expect(out.at(-1)).toMatchObject({ lines: 5 }); // a `\n` split across deltas still counts
    expect(out).toHaveLength(4);
  });

  it('reads a description, counts nothing for a tool without content, and stops at end or clear', () => {
    const { p, out, tick } = world();
    p.start('tu2', 'Bash');
    tick(PREPARING_INTERVAL_MS);
    p.input('tu2', '{"command":"ls\\nx","description":"List \\"files\\""}');
    expect(out.at(-1)).toMatchObject({ toolName: 'Bash', description: 'List "files"', lines: null, path: null });
    p.end('tu2');
    tick(PREPARING_INTERVAL_MS);
    p.input('tu2', 'more');
    p.start('tu3', 'Edit');
    p.clear();
    tick(PREPARING_INTERVAL_MS);
    p.input('tu3', '{"new_string":"a\\nb"}');
    expect(out.map((d) => d.callId)).toEqual(['tu2', 'tu2', 'tu3']);
  });

  it('sends nothing when nothing changed', () => {
    const { p, out, tick } = world();
    p.start('tu4', 'Read');
    tick(PREPARING_INTERVAL_MS);
    p.input('tu4', '{"limit":');
    tick(PREPARING_INTERVAL_MS);
    p.input('tu4', '10}');
    expect(out).toHaveLength(1);
  });
});
