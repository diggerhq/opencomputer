// The repository index appended to a fork's AGENTS.md (work 056): every
// repository the definition grants, checked out or not, so the model knows
// what exists from its first turn without anything being cloned first. Pure.
//
// Invariants: written only when some repository is not checked out (a
// workspace whose definition is fully cloned, like ours, gets its AGENTS.md
// unchanged); at most LIMIT rows, most recently pushed first, the rest named
// on one line; descriptions are one line (definition.ts bounds them).

import { type RepoDef, repoSlug } from './definition.js';

const LIMIT = 50;

export const INDEX_HEADING = '## Repositories in this workspace';

/** Markdown for the index, or undefined when every published repository is checked out. */
export function repoIndex(repos: RepoDef[], checkedOut: Set<string>, limit = LIMIT): string | undefined {
  const listed = repos.filter((r) => !r.unpublished);
  if (listed.every((r) => checkedOut.has(r.name))) return undefined;
  const sorted = [...listed].sort((a, b) => {
    const here = Number(checkedOut.has(b.name)) - Number(checkedOut.has(a.name));
    return here || (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '') || a.name.localeCompare(b.name);
  });
  const shown = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const n = listed.length;
  const lines = [
    INDEX_HEADING,
    '',
    `${n} ${n === 1 ? 'repository is' : 'repositories are'} available to this session. Checked-out ones are subdirectories ` +
      'here, each on this session\'s branch. Check out any other with the `checkout_repo` tool when a task needs it: the ' +
      'first checkout clones it, which takes seconds for most repositories. To find which repository holds something ' +
      'before checking out, search with `gh search code <query> --owner <owner>`.',
    '',
    '| Repository | Here | About |',
    '|---|---|---|',
    ...shown.map((r) => `| \`${r.name}\` (${cell(repoSlug(r.remote))}) | ${checkedOut.has(r.name) ? 'yes' : '—'} | ${about(r)} |`),
  ];
  if (rest.length) lines.push('', `Also available: ${rest.map((r) => `\`${r.name}\``).join(', ')}.`);
  return `${lines.join('\n')}\n`;
}

/** Gateway text in a table cell: a pipe would end the cell, however escaped. */
const cell = (s: string) => s.replace(/\|/g, '/');

function about(r: RepoDef) {
  const parts = [r.language, r.description, r.pushedAt && `pushed ${r.pushedAt.slice(0, 10)}`];
  return cell(parts.filter(Boolean).join(' · '));
}
