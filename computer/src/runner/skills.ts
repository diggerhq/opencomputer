// Project skills Calvin gives every session: markdown files under
// src/runner/skills/, written into the session directory's .claude/skills/
// before the harness starts (it loads project settings, so Claude Code lists
// them). Written on every start, so a Calvin update reaches running sessions
// at their next harness start; skills Calvin no longer ships are removed, by
// the manifest of what it wrote last time. A session directory is normally
// not a git repository, but a developer's WORKDIR can be one, so what is
// written is also excluded there (.git/info/exclude), never committed. A
// workspace fork also gets settings hiding bundled skills (skill-settings.ts).

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { hideBundledSkills } from './skill-settings.js';

const SOURCE = path.join(import.meta.dirname, 'skills');
/** Under `.claude/skills/`: the names Calvin wrote, so renamed or dropped ones are removed. */
const MANIFEST = '.calvin-skills';

/** `<cwd>/.claude/skills/<name>/SKILL.md` for every `skills/<name>.md`. Synchronous: the harness scans them as it starts. Never throws. */
export function ensureSkills(cwd: string, source = SOURCE): string[] {
  const written: string[] = [];
  try {
    const root = path.join(cwd, '.claude', 'skills');
    mkdirSync(root, { recursive: true });
    const names = readdirSync(source)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
    for (const stale of previous(root).filter((n) => !names.includes(n))) rmSync(path.join(root, stale), { recursive: true, force: true });
    for (const name of names) {
      mkdirSync(path.join(root, name), { recursive: true });
      copyFileSync(path.join(source, `${name}.md`), path.join(root, name, 'SKILL.md'));
      written.push(name);
    }
    writeFileSync(path.join(root, MANIFEST), written.map((n) => `${n}\n`).join(''));
    gitExclude(cwd, [...written.map((n) => `.claude/skills/${n}/`), `.claude/skills/${MANIFEST}`]);
  } catch (e) {
    log.warn(`skills: ${(e as Error).message}`);
  }
  hideBundledSkills(cwd); // a workspace fork's settings hide bundled skills of no use there (skill-settings.ts)
  return written;
}

function previous(root: string): string[] {
  try {
    return readFileSync(path.join(root, MANIFEST), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** When `cwd` is a git repository, keep Calvin's files out of its commits without touching tracked files. */
function gitExclude(cwd: string, entries: string[]) {
  const git = path.join(cwd, '.git');
  if (!existsSync(git)) return;
  const file = path.join(git, 'info', 'exclude');
  const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const add = entries.filter((e) => !have.split('\n').includes(e));
  if (!add.length) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
}
