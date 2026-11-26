// The work-tracking section of a fork's AGENTS.md (design 3.3): which
// repository is the organization's knowledge repository and the conventions
// for its items. Pure.
//
// Invariants: present only when the definition has a `role: "knowledge"`
// repository (definition.ts allows at most one); it comes from the release,
// never from the repository, so a session cannot rewrite what the next one is
// told about work tracking (design 5). The rules a hook enforces (the Session
// trailer, unique numbers) are stated as what happens, not asked of the agent.

import { isKnowledge, type RepoDef, repoSlug } from './definition.js';

export const KNOWLEDGE_HEADING = '## Work tracking';

/**
 * Markdown for the section, or undefined when the definition has no knowledge
 * repository. `branch`: its default branch as the clone knows it, when the
 * definition does not name one.
 */
export function knowledgeSection(repos: RepoDef[], checkedOut: Set<string>, branch?: string): string | undefined {
  const repo = repos.find((r) => isKnowledge(r) && !r.unpublished);
  if (!repo) return undefined;
  const dir = `\`${repo.name}\``;
  const main = repo.branch ?? branch ?? 'main';
  const lines = [
    KNOWLEDGE_HEADING,
    '',
    `${dir} (${repoSlug(repo.remote)}) is this organization's knowledge repository: its \`work/\` holds the open work items, ` +
      `\`done/\` the closed ones, and everything else in it is documents. ${checkedOut.has(repo.name) ? `It is checked out here as ${dir}.` : `Check it out with \`checkout_repo\` when you need it.`}`,
    '',
    `- It is the exception to "never push to a default branch": changes to it go straight to \`${main}\`, never through ` +
      `a pull request. \`git pull --rebase origin ${main}\`, edit, commit, \`git push origin HEAD:${main}\`; when the push ` +
      'is refused, pull with rebase and push again. Push promptly: unpushed work is invisible to everyone else.',
    '- An item is `work/NN-slug.md`, about work that outlives this session. When a person asks to track something, or ' +
      'your work will outlast this sitting, look for an existing item first and keep it current; otherwise create one ' +
      'and say "Now tracked as NN". A new item takes one more than the highest number in `work/` and `done/` after a ' +
      'fetch; the push is refused, with the number to take instead, if another session took it first.',
    '- The file: optional frontmatter `owner:` (one email) and `tags:` (comma-separated), a `# ` title, then one line on ' +
      'where it stands. Pull requests on lines starting `PR:`. What is left as `- [ ]` checkboxes under `## Left`: keep ' +
      'it true, and check items off as they are done.',
    '- Never move an item to `done/` unless a person tells you to; when nothing is left, say so and let its owner close it.',
    '- Commits get a `Session:` trailer on their own; it is how an item finds the sessions that worked on it. Keep it.',
  ];
  return `${lines.join('\n')}\n`;
}
