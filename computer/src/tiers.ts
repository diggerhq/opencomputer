// Model tiers: people pick how much model they want, we pick which model that
// is, per harness (a Codex thread's `smart` is OpenAI's frontier model). A
// message starting with `+smart` or `+fast` (or `+default`) switches the
// thread's model, like `!model`, and the rest of the message goes to the agent.

import type { HarnessName } from './protocol.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** The reasoning effort a session runs at until `!effort` changes it. */
export const DEFAULT_EFFORT = 'medium' as const;

export type Tier = 'smart' | 'fast' | 'default';

/** Each harness's model for each tier; Codex's are in its catalog (`model/list`, 0.163.0). */
export const TIERS: Record<HarnessName, Record<Tier, string>> = {
  claude: {
    smart: 'claude-fable-5-2',
    fast: 'claude-sonnet-5-5',
    default: process.env.MODEL || DEFAULT_MODEL,
  },
  codex: {
    smart: 'gpt-6-astra',
    fast: 'gpt-6-luna',
    default: 'gpt-6.1-sol',
  },
};

const LEADING = /^\+(smart|fast|default)\b\s*/i;

/** `+smart fix the bug` → `{ tier: 'smart', rest: 'fix the bug' }`; no modifier → `{ rest: text }`. */
export function takeTier(text: string): { tier?: Tier; rest: string } {
  const m = LEADING.exec(text);
  return m ? { tier: m[1].toLowerCase() as Tier, rest: text.slice(m[0].length) } : { rest: text };
}

/** The tier a model id belongs to, for display (ids are unique across harnesses). */
export function tierOf(model: string): Tier | undefined {
  for (const tiers of Object.values(TIERS)) {
    const t = (Object.keys(tiers) as Tier[]).find((k) => tiers[k] === model);
    if (t) return t;
  }
}

/** `smart (`claude-fable-5-2`)` for a tier's model, else just the id. */
export function modelLabel(id: string) {
  const t = tierOf(id);
  return t ? `${t} (\`${id}\`)` : `\`${id}\``;
}
