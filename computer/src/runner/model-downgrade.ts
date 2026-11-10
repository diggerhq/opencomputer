// A Claude subscription's model ceiling (work 077). The seat's entitlements
// are unknown up front (no bootstrap on the proxy's socket), so a Pro seat
// asked for Opus finds out from the API: Claude Code turns the error into an
// assistant message with `error: 'model_not_found'`. The runner then steps the
// session one family down (fable → opus → sonnet → haiku), retries the turn
// once, says so in the thread, and the host reports `model-denied` so the
// gateway starts the owner's next threads at the ceiling.
//
// Invariant: only ever downward, one family per denial; a model with no
// known family is never switched (it may be a full id the person chose).

/** Families from the most to the least capable, each with the id a downgrade switches to. */
const LADDER = [
  ['fable', 'claude-fable-5-2'],
  ['opus', 'claude-opus-5-5'],
  ['sonnet', 'claude-sonnet-5-5'],
  ['haiku', 'claude-haiku-5-5'],
] as const;

const rank = (model: string) => LADDER.findIndex(([family]) => model.toLowerCase().includes(family));

/** The family's display name (`Opus`), or the id when it has none. */
export function familyName(model: string) {
  const i = rank(model);
  return i < 0 ? model : LADDER[i][0][0].toUpperCase() + LADDER[i][0].slice(1);
}

/** The next model down from `model`; undefined at the bottom or for an unknown family. */
export function nextDown(model: string): string | undefined {
  const i = rank(model);
  return i < 0 ? undefined : LADDER[i + 1]?.[1];
}

/** Whether `model` is above the subscription's ceiling `max` (both known families). */
export function aboveCeiling(model: string, max: string | undefined) {
  if (!max) return false;
  const [m, c] = [rank(model), rank(max)];
  return m >= 0 && c >= 0 && m < c;
}

/** The line posted when a model is refused or `!model` asks above the ceiling. */
export const deniedLine = (model: string, to: string) =>
  `Your Claude subscription doesn't include ${familyName(model)}; this thread is on ${familyName(to)}.`;

/** What a retried turn says to the model: the request that failed is the one to redo. */
export const RETRY_TEXT = 'The last request failed because the model was not available on this subscription; it has been switched. Continue where you left off.';
