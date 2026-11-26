import { describe, expect, it } from 'vitest';
import { trackTools } from './track-tools.js';
import type { Work } from './work.js';

const TID = 'trk_0000000000000001';

function rig(answers: (method: string, path: string, o: any) => unknown) {
  const calls: Array<{ method: string; path: string; o: any }> = [];
  const w: Work = {
    api: { call: async (method, path, o) => (calls.push({ method, path, o }), answers(method, path, o)) },
    session: () => ({ id: 'cs_0000000000000001', role: { name: 'track', trackId: TID } as never }),
  };
  const tools = Object.fromEntries(trackTools(w).map((t) => [t.name, t]));
  return { tools, calls };
}

describe('the Doc tools', () => {
  it("read a new track's Doc, empty at revision 0, from the track's own route, and edit it at once", async () => {
    const t = rig((method, path) => {
      if (method === 'GET' && path === `/work/tracks/${TID}/doc`) return { protocol: 1, doc: { kind: 'doc', id: TID, rev: 0, text: '', spans: [] } };
      if (method === 'PUT' && path === `/work/tracks/${TID}/doc`) return { protocol: 1, value: { rev: 1 } };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const read = await t.tools.doc_read!.handler({});
    expect(read.isError).toBeUndefined();
    expect(read.content[0].text).toBe('Revision 0.\n---\n');
    const edit = await t.tools.doc_edit!.handler({ old: '', new: '# Plan' }, { id: 'toolu_1' } as never);
    expect(edit.content[0].text).toBe('Saved revision 1.');
    expect(t.calls[1]).toMatchObject({ method: 'PUT', o: { body: { baseRev: 0, text: '# Plan' }, key: expect.any(String) } });
  });

  it('set_stand is the track route', async () => {
    const t = rig(() => ({ protocol: 1 }));
    const r = await t.tools.set_stand!.handler({ stand: 'Waiting on you.' }, { id: 'toolu_2' } as never);
    expect(r.content[0].text).toBe('Set.');
    expect(t.calls).toMatchObject([{ method: 'PUT', path: `/work/tracks/${TID}/stand`, o: { body: { stand: 'Waiting on you.' } } }]);
  });
});
