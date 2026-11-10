// Claude Code's bundled skills a session on a headless computer has no use
// for, hidden from the model by `skillOverrides` in the workspace fork's
// `.claude/settings.json`. The skills list sits in Claude Code's environment
// block, which every session writes to the prompt cache afresh, so each
// listing removed is saved on every session's first request.
//
// Invariants: only a workspace fork (a folder with FORK_FILE) gets the file;
// its root is not a git repository, and the repositories are worktrees below
// it, so nothing here is ever committed. The settings are merged, never
// clobbered: an existing entry for a skill wins, other keys are kept, and a
// file that isn't a JSON object is left alone. Given the same starting file
// the result is byte-identical, so every session of a workspace sends the
// same skills list. `skillOverrides` is only read from settings files, not
// from the SDK's `settings` option, hence a file. Never throws.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { FORK_FILE } from '../workspaces/idle.js';

/** Bundled skills hidden in a workspace fork, each with why it is of no use there. */
export const HIDDEN_SKILLS: Record<string, string> = {
  'keybindings-help': 'keyboard shortcuts of the terminal UI; there is no terminal',
  'plugin-authoring': "mods to Claude Code's own interface (panes, status line, toasts); there is no interface",
  loop: 'recurring work inside the session, which parks and drops it; recurring work is an automation',
  'fewer-permission-prompts': "edits the permission allowlist in project settings; Calvin's gate decides permissions",
  'update-config': "edits Claude Code's settings and hooks; Calvin owns them, and the session folder's copy dies with it",
};

/** Merge HIDDEN_SKILLS into `<cwd>/.claude/settings.json` when `cwd` is a workspace fork; whether the file now hides them. */
export function hideBundledSkills(cwd: string): boolean {
  try {
    if (!existsSync(path.join(cwd, FORK_FILE))) return false;
    const file = path.join(cwd, '.claude', 'settings.json');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    const after = mergedSettings(before);
    if (after === undefined) return false;
    if (after !== before) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, after);
    }
    return true;
  } catch (e) {
    log.warn(`skill settings: ${(e as Error).message}`);
    return false;
  }
}

/** The settings text with every hidden skill `off` unless already set; undefined when `text` is not a JSON object. Pure. */
export function mergedSettings(text: string | undefined): string | undefined {
  let settings: Record<string, unknown> = {};
  if (text !== undefined && text.trim()) {
    try {
      settings = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!isObject(settings)) return undefined;
  }
  const overrides = settings.skillOverrides ?? {};
  if (!isObject(overrides)) return undefined;
  const merged = { ...Object.fromEntries(Object.keys(HIDDEN_SKILLS).map((n) => [n, 'off'])), ...overrides };
  const next = `${JSON.stringify({ ...settings, skillOverrides: merged }, null, 2)}\n`;
  // Unchanged meaning: keep their bytes as they were.
  return text !== undefined && JSON.stringify(JSON.parse(text || '{}')) === JSON.stringify({ ...settings, skillOverrides: merged }) ? text : next;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
