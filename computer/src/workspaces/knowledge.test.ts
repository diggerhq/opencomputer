import { describe, expect, it } from 'vitest';
import type { RepoDef } from './definition.js';
import { KNOWLEDGE_HEADING, knowledgeSection } from './knowledge.js';

const repo = (name: string, extra: Partial<RepoDef> = {}): RepoDef => ({ name, remote: `https://github.com/acme/${name}`, ...extra });

describe('knowledgeSection', () => {
  it('is omitted without a published knowledge repository', () => {
    expect(knowledgeSection([repo('api'), repo('web')], new Set(['api', 'web']))).toBeUndefined();
    expect(knowledgeSection([repo('notes', { role: 'knowledge', unpublished: true })], new Set(['notes']))).toBeUndefined();
    expect(knowledgeSection([], new Set())).toBeUndefined();
  });

  it('names the repository, where it is and its default branch', () => {
    const md = knowledgeSection([repo('api'), repo('notes', { role: 'knowledge' })], new Set(['api', 'notes']), 'trunk')!;
    expect(md.startsWith(`${KNOWLEDGE_HEADING}\n`)).toBe(true);
    expect(md).toContain("`notes` (acme/notes) is this organization's knowledge repository");
    expect(md).toContain('checked out here as `notes`');
    expect(md).toContain('git push origin HEAD:trunk');
    expect(md).toContain('`work/NN-slug.md`');
    expect(md).toContain('Never move an item to `done/`');
    expect(md).toContain('`Session:` trailer');
    expect(md).not.toContain('api');
  });

  it('points at checkout_repo when it is not checked out, and prefers the branch the definition names', () => {
    const md = knowledgeSection([repo('notes', { role: 'knowledge', branch: 'live' })], new Set(), 'trunk')!;
    expect(md).toContain('`checkout_repo`');
    expect(md).not.toContain('checked out here');
    expect(md).toContain('git pull --rebase origin live');
    expect(knowledgeSection([repo('notes', { role: 'knowledge' })], new Set())).toContain('HEAD:main');
  });
});
