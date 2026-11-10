import { describe, expect, it, vi } from 'vitest';
import { cardSender, componentList, toSlack } from './post-card.js';

const spec = {
  root: 'c',
  elements: {
    c: { type: 'Card', props: { title: 'Deploys' }, children: ['f', 't', 'a'] },
    f: { type: 'Fields', props: {}, children: ['f1'] },
    f1: { type: 'Field', props: { label: 'Env', value: 'prod' }, children: [] },
    t: { type: 'Table', props: { headers: ['svc', 'p95'], rows: [['api', '120ms']] }, children: [] },
    a: { type: 'Actions', props: {}, children: ['l'] },
    l: { type: 'LinkButton', props: { label: 'Open', url: 'https://example.com' }, children: [] },
  },
};

describe('toSlack', () => {
  // Pins the Block Kit json-render and Chat SDK produce, so an upgrade that changes it fails here.
  it('renders a card as Block Kit', () => {
    const { blocks, text } = toSlack(spec);
    expect(blocks.map((b) => b.type)).toEqual(['header', 'section', 'data_table', 'actions']);
    expect(JSON.stringify(blocks)).toContain('https://example.com');
    expect(text).toContain('Deploys');
  });

  it('refuses Button: clicks are not routed back yet', () => {
    const bad = { root: 'c', elements: { ...spec.elements, l: { type: 'Button', props: { id: 'go', label: 'Go' }, children: [] } } };
    expect(() => toSlack(bad)).toThrow();
  });

  it('refuses a second table rather than degrading it', () => {
    const two = { ...spec, elements: { ...spec.elements, c: { ...spec.elements.c, children: ['t', 't2'] }, t2: spec.elements.t } };
    expect(() => toSlack(two)).toThrow();
  });
});

describe('cardSender', () => {
  it('posts a valid card', async () => {
    const post = vi.fn(async () => {});
    expect(await cardSender(post)(spec)).toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledOnce();
  });

  it('returns the issues of an invalid spec, posting nothing', async () => {
    const post = vi.fn(async () => {});
    const r = await cardSender(post)({ root: 'c', elements: { c: { type: 'Card', props: { title: 1 }, children: ['x'] } } });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^invalid card spec:\n- /);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a card holding a secret', async () => {
    const post = vi.fn(async () => {});
    const r = await cardSender(post, (b) => (b.toString().includes('prod') ? 'DEPLOY_ENV' : undefined))(spec);
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining('$DEPLOY_ENV') });
    expect(post).not.toHaveBeenCalled();
  });

  it('reports why Slack refused', async () => {
    const r = await cardSender(async () => Promise.reject({ data: { error: 'invalid_blocks' } }))(spec);
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining('invalid_blocks') });
  });
});

describe('componentList', () => {
  it('lists the catalog without Button', () => {
    const list = componentList();
    expect(list).toContain('- Card:');
    expect(list).toContain('- LinkButton:');
    expect(list).not.toMatch(/^- Button:/m);
  });
});
