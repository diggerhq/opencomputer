import { describe, expect, it } from 'vitest';
import type { PreviewRequest } from '../protocol.js';
import { previewTools } from './preview.js';

function tools(fail?: string) {
  const asked: PreviewRequest[] = [];
  const removed: string[] = [];
  const [preview, unpreview] = previewTools({
    preview: async (req) => {
      if (fail) throw new Error(fail);
      asked.push(req);
      return { url: 'https://demo.opencomputer.app', name: 'demo', port: req.port, listening: false, hint: 'add a line' };
    },
    unpreview: async (name) => void removed.push(name),
  });
  const run = async (t: typeof preview, input: object) => {
    const r = await t.handler(input as never);
    return { text: (r.content[0] as { text: string }).text, isError: !!r.isError };
  };
  return { asked, removed, preview: (i: object) => run(preview, i), unpreview: (i: object) => run(unpreview, i) };
}

describe('preview tools', () => {
  it('returns the URL, whether the port answered, and the hint', async () => {
    const t = tools();
    const r = await t.preview({ port: 5173, name: 'demo' });
    expect(JSON.parse(r.text)).toEqual({ url: 'https://demo.opencomputer.app', name: 'demo', listening: false, hint: 'add a line' });
    expect(t.asked).toEqual([{ port: 5173, name: 'demo' }]);
    expect(await t.unpreview({ name: ' demo ' })).toEqual({ text: '{}', isError: false });
    expect(t.removed).toEqual(['demo']);
  });

  it('refuses a name that is not one DNS label, and returns the gateway\'s sentence as an error', async () => {
    const t = tools('demo is taken by another organization; try demo-7');
    expect((await t.preview({ port: 3000, name: 'My App' })).isError).toBe(true);
    expect(await t.preview({ port: 3000 })).toEqual({ text: 'demo is taken by another organization; try demo-7', isError: true });
  });
});
