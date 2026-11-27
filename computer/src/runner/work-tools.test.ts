import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoke, jsonSchema } from './tool.js';
import type { Work } from './work.js';
import { fileResult, workTools } from './work-tools.js';

const RES = 'res_0000000000000001';
const summary = {
  head: 'abc123',
  parts: [
    {
      title: 'Rows load in one query',
      claim: '`loadRows` asks once for every row of the organization.',
      points: ['The loop over ids is gone.'],
      files: [{ path: 'src/rows.ts', note: 'The query and the sort.' }, { path: 'src/rows.test.ts' }],
      excerpts: [{ path: 'src/rows.ts', side: 'new', start: 10, end: 14, why: 'The query.' }],
      eye: [{ text: 'The order now comes from the query.', path: 'src/rows.ts', line: 12 }],
    },
  ],
};

function rig() {
  const calls: Array<{ method: string; path: string; o: any }> = [];
  const w: Work = {
    api: { call: async (method, path, o) => (calls.push({ method, path, o }), { protocol: 1 }) },
    session: () => ({ id: 'cs_0000000000000001' }) as never,
  };
  const tool = workTools(w).find((t) => t.name === 'review_summary')!;
  return { tool, calls };
}

describe('review_summary', () => {
  it('sends the summary the model wrote to the review route, unchanged', async () => {
    const t = rig();
    const r = await invoke(t.tool, { result: RES, ...summary }, { id: 'toolu_1' });
    expect(r).toEqual({ content: [{ type: 'text', text: 'Saved the review summary.' }] });
    expect(t.calls).toEqual([{ method: 'PUT', path: `/work/results/${RES}/review`, o: { body: summary, key: expect.any(String) } }]);
  });

  it('refuses parts as an object, a part without a claim, and a field the summary does not have, before any call', async () => {
    const t = rig();
    for (const parts of [{ Rows: 'why' }, [{ title: 'Rows', files: [{ path: 'a' }] }], [{ ...summary.parts[0], weight: 'eye' }]]) {
      const r = await invoke(t.tool, { result: RES, head: 'abc123', parts });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Invalid arguments for tool review_summary: parts/);
    }
    expect(t.calls).toEqual([]);
  });

  it("shows the model the summary's fields, with what each is for", () => {
    const s = jsonSchema(rig().tool) as any;
    const part = s.properties.parts.items;
    expect(s.required).toEqual(expect.arrayContaining(['result', 'head', 'parts']));
    expect(Object.keys(part.properties)).toEqual(['title', 'claim', 'points', 'files', 'excerpts', 'eye']);
    expect(part.properties.excerpts.items.required).toEqual(['path', 'start', 'end']);
    for (const k of ['claim', 'points', 'excerpts', 'eye']) expect(part.properties[k].description).toBeTruthy();
  });

  it("reads the SDK's schema, copied unchanged (sdks/typescript: npm run schema)", () => {
    const sdk = path.resolve(import.meta.dirname, '../../../sdks/typescript/schema/review.v1.json');
    // The release holds computer/ only; in the repository the copy must match.
    if (!existsSync(sdk)) return;
    expect(readFileSync(path.resolve(import.meta.dirname, '../../schema/review.v1.json'), 'utf8')).toBe(readFileSync(sdk, 'utf8'));
  });
});

describe('fileResult', () => {
  const rigFile = () => {
    const calls: Array<{ path: string; o: { body: Record<string, unknown>; key: string } }> = [];
    const w: Work = { api: { call: async (_m, p, o) => (calls.push({ path: p, o: o as never }), { protocol: 1 }) }, session: () => ({ id: 'cs_0000000000000001' }) as never };
    return { w, calls };
  };

  it('names a file in the workspace by its path there', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const { w, calls } = rigFile();
    await fileResult(w, cwd, { path: path.join(cwd, 'repo', 'chart.png'), filename: 'chart.png' });
    expect(calls[0]!.o.body).toMatchObject({ kind: 'file', ref: 'repo/chart.png', title: 'chart.png' });
  });

  it('copies a file from outside the workspace into .sent/, by its content: the same bytes are the same result', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'render-'));
    writeFileSync(path.join(tmp, 'shot.png'), 'png bytes');
    const { w, calls } = rigFile();
    await fileResult(w, cwd, { path: path.join(tmp, 'shot.png'), filename: 'shot.png' });
    await fileResult(w, cwd, { path: path.join(tmp, 'shot.png'), filename: 'shot.png' });
    const ref = calls[0]!.o.body.ref as string;
    expect(ref).toMatch(/^\.sent\/[0-9a-f]{16}\/shot\.png$/);
    expect(readFileSync(path.join(cwd, '.sent', '.gitignore'), 'utf8')).toBe('*\n');
    expect(readFileSync(path.join(cwd, ref), 'utf8')).toBe('png bytes');
    expect(calls[1]!.o.key).toBe(calls[0]!.o.key);
  });
});
