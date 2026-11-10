// What a Bash call was for, in coarse kinds, so time spent in `Bash` can be
// told apart in SQL: a screenshot from a test run, a package install from a
// dev server (work 063). Only the kinds leave the runner, never the command:
// it can hold paths, URLs and secrets.
//
// A kind is matched where a command starts (the line, or after `;`, `&&`, `|`,
// `(`, `$(`, optional VAR=value prefixes and `npx`/`sudo`/`time`), never by a
// word anywhere in the text: `cat playwright.config.ts` and `pkill chromium`
// are not renders. It stays a heuristic: `node shot.mjs` says nothing about
// what the script does, so a render is often only seen by its `file.posted`.

export const COMMAND_KINDS = ['browser', 'media', 'post', 'install', 'server', 'git', 'build'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** Where a command starts, with the wrappers that don't change what it is. */
const HEAD = String.raw`(?:^|[;&|(]\s*|\$\(\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:npx|sudo|time|nohup|exec)\s+(?:-\S+\s+)*)?`;
const cmd = (names: string, flags = 'm') => new RegExp(`${HEAD}(?:${names})\\b`, flags);

const RULES: [CommandKind, RegExp][] = [
  // `playwright test` is an e2e run and `playwright install` a download, not renders.
  ['browser', cmd(String.raw`playwright(?!\s+(?:test|install|codegen|--version))|chromium(?:-browser)?|chrome-headless-shell|google-chrome(?:-stable)?|wkhtmltoimage|wkhtmltopdf`)],
  ['media', cmd(String.raw`ffmpeg|ffprobe|magick|rsvg-convert|mmdc|dot\s+-T\w+|remotion`)],
  ['post', cmd('calvin-send-file')],
  [
    'install',
    cmd(
      String.raw`npm\s+(?:i|install|ci|link|add)|pnpm\s+(?:i|install|add|link)|yarn(?:\s+(?:add|install))?(?=\s*(?:$|[;&|)]))|pip3?\s+install|uv\s+(?:pip|add|sync)|apt(?:-get)?\s+(?:install|download)|dpkg\s+-x|playwright\s+install|go\s+(?:get|install)|cargo\s+install|brew\s+install`,
    ),
  ],
  [
    'server',
    new RegExp(
      `${HEAD}(?:npm\\s+run\\s+(?:dev|start|serve|preview)|pnpm\\s+(?:dev|start)|vite(?:\\s|$)|next\\s+(?:dev|start)|python3?\\s+-m\\s+http\\.server|serve\\s|wrangler\\s+dev)|(?<!&)&\\s*$`,
      'm',
    ),
  ],
  ['git', cmd('git|gh')],
  ['build', cmd(String.raw`npm\s+(?:run|test|t)\b|pnpm\s+(?:run|test|build)|npx\s+(?:tsc|vitest|jest)|yarn\s+(?:test|build|run)|tsc|vitest|jest|pytest|go\s+(?:test|build|vet)|cargo\s+(?:build|test|check)|make|gradle|mvn`)],
];

/** The kinds a command matches, in COMMAND_KINDS order; empty when none does. */
export function commandKinds(command: unknown): CommandKind[] {
  if (typeof command !== 'string') return [];
  return RULES.filter(([, re]) => re.test(command)).map(([k]) => k);
}
