// Where Claude Code compacts a conversation (work 068 §1): its auto-compact
// window, decided where a process starts; the harness copies the environment
// when it spawns.
//
// Why: past 200k tokens every model step waited ~15 s for its first token
// (1.4 s below), and past ~300k the 1-hour prompt cache stopped surviving a
// pause. Opus runs with the 1M window here, so Claude Code alone compacted
// only near 1M. Threads are compacted between turns, in a fork, from 120k
// (shadow.ts); this window is the backstop for a turn that grows past ~150k
// on its own, where Claude Code compacts inside the turn and the turn waits.
//
// What the number means (measured on Claude Code 2.1.295, not documented):
// CLAUDE_CODE_AUTO_COMPACT_WINDOW is floored at 100k; Claude Code reserves 20k
// of it for output and compacts 13k before the rest, so it compacts once a
// request would carry `window - 33k` tokens (150k at 183k). The check runs
// before every request, mid-turn too.

const VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const DEFAULT_CONTEXT_WINDOW = '183000';

/**
 * The window to set; undefined leaves Claude Code's own (the model's window).
 * `explicit` (SP_CONTEXT_WINDOW) wins, `0` meaning Claude Code's default; then
 * what the process was started with (`preset`); then 183k. A value that is
 * not a token count counts as unset.
 */
export function contextWindow(explicit: string | undefined, preset: string | undefined): string | undefined {
  const v = (explicit ?? '').trim();
  if (v === '0') return undefined;
  // Not a token count: the default, rather than every runner failing to start.
  if (/^\d+$/.test(v)) return v;
  return (preset && /^\d+$/.test(preset) ? preset : undefined) ?? DEFAULT_CONTEXT_WINDOW;
}

/** Set (or clear) Claude Code's auto-compact window in `env`. */
export function applyContextWindow(env: NodeJS.ProcessEnv, explicit = env.SP_CONTEXT_WINDOW) {
  const v = contextWindow(explicit, env[VAR]);
  if (v) env[VAR] = v;
  else delete env[VAR];
}
