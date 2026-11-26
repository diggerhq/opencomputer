import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSkills } from './skills.js';

const scratch = () => mkdtemp(path.join(tmpdir(), 'calvin-skills-'));

describe('ensureSkills', () => {
  it('writes every shipped skill as SKILL.md with frontmatter a strict YAML parser accepts', async () => {
    const cwd = await scratch();
    expect(ensureSkills(cwd)).toContain('slack-formatting');
    const md = await readFile(path.join(cwd, '.claude', 'skills', 'slack-formatting', 'SKILL.md'), 'utf8');
    const [, fm] = md.split('---\n');
    expect(fm).toMatch(/^name: [a-z-]+\n/);
    // A description holding ": " must be quoted, or YAML reads a nested mapping.
    expect(fm).toMatch(/\ndescription: "(?:[^"\\]|\\.)*"\n/);
    expect(md).toContain('## Pitfalls');
  });

  it('removes a skill it wrote before that is no longer shipped, and leaves others alone', async () => {
    const cwd = await scratch();
    const source = await scratch();
    await writeFile(path.join(source, 'old.md'), '---\nname: old\ndescription: "x"\n---\n');
    expect(ensureSkills(cwd, source)).toEqual(['old']);
    await mkdir(path.join(cwd, '.claude', 'skills', 'theirs'), { recursive: true });
    await writeFile(path.join(source, 'new.md'), '---\nname: new\ndescription: "y"\n---\n');
    const { unlink } = await import('node:fs/promises');
    await unlink(path.join(source, 'old.md'));
    expect(ensureSkills(cwd, source)).toEqual(['new']);
    expect(existsSync(path.join(cwd, '.claude', 'skills', 'old'))).toBe(false);
    expect(existsSync(path.join(cwd, '.claude', 'skills', 'theirs'))).toBe(true);
  });

  it('in a git repository, excludes what it wrote without touching tracked files', async () => {
    const cwd = await scratch();
    await mkdir(path.join(cwd, '.git', 'info'), { recursive: true });
    await writeFile(path.join(cwd, '.git', 'info', 'exclude'), '*.log');
    ensureSkills(cwd);
    ensureSkills(cwd); // idempotent
    const exclude = await readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toBe('*.log\n.claude/skills/slack-formatting/\n.claude/skills/.calvin-skills\n');
  });

  it('a missing source directory is a warning, not a failure', async () => {
    const cwd = await scratch();
    expect(ensureSkills(cwd, path.join(cwd, 'nope'))).toEqual([]);
  });
});
