// `!model <id>` and a `+tier` prefix: switching a session's model (and
// `!effort <level>`, its reasoning effort, and `!speed`, at the end). The harness
// validates the id (Claude Code: one tiny API call) and applies it from the
// next API request, mid-turn too. Nothing changes unless it accepts it, so a typo
// can't be persisted into every later turn and restart.

import { Effect } from 'effect';
import type { EffortLevel, Speed } from '../protocol.js';
import type { Harness } from './harness/types.js';
import { DEFAULT_EFFORT, TIERS, modelLabel, type Tier } from '../tiers.js';
import { aboveCeiling, deniedLine } from './model-downgrade.js';

/** What a switch needs from its session. */
export interface ModelHost {
  info: { model?: string; effort?: EffortLevel; speed?: Speed; kind: 'thread' | 'channel' };
  /** The model in effect. */
  model: string;
  /** The route's model ceiling, `maxModel` (work 097 C5). */
  maxModel?: string;
  isBusy: boolean;
  say(text: string): Promise<void>;
  /** The session's harness, started if it is not up. */
  ensureHarness(): Harness;
  persist(): void;
  updateContextBar(): Promise<void>;
}

const isTier = (v: string): v is Tier => v === 'smart' || v === 'fast' || v === 'default';

export async function switchModel(s: ModelHost, arg: string) {
  if (!arg) return s.say(`model: ${modelLabel(s.model)}\n${await choices(s)}`);
  // A tier (`smart`, `fast`, `default`) is ours to map to a model id, the running harness's.
  const tier = arg.toLowerCase();
  const id = isTier(tier) ? TIERS[s.ensureHarness().id][tier] : arg;
  if (id === s.model) return s.say(`model: ${modelLabel(id)} (already)`);
  if (aboveCeiling(id, s.maxModel)) return s.say(deniedLine(id, s.model));
  try {
    await Effect.runPromise(s.ensureHarness().setModel(id));
  } catch (e: any) {
    return s.say(`:warning: can't switch to \`${arg}\`: ${e?.message ?? e}; still on \`${s.model}\`\n${await choices(s)}`);
  }
  // An alias (`opus`) becomes the full id at the next turn's init.
  s.info.model = id;
  s.persist();
  if (s.info.kind === 'channel') void s.updateContextBar();
  return s.say(`model → ${modelLabel(id)}${s.isBusy ? ' (from the next step of this turn)' : ''}`);
}

async function choices(s: ModelHost) {
  const ms = await Effect.runPromise(s.ensureHarness().models).catch(() => []);
  const names = ms.map((m) => m.id).filter((v) => v !== 'default');
  const tiers = Object.keys(TIERS.claude)
    .map((v) => `\`${v}\``)
    .join(', ');
  return names.length ? `choices: ${tiers}, or ${names.map((v) => `\`${v}\``).join(', ')}, or a full model id` : `choices: ${tiers}`;
}

export const effortOf = (info: { effort?: EffortLevel }) => info.effort ?? DEFAULT_EFFORT;

/** `!effort <level>`: from the next request, mid-turn too, and every later start. */
export async function switchEffort(s: Pick<ModelHost, 'info' | 'isBusy' | 'say' | 'ensureHarness' | 'persist'>, arg: string) {
  const effort = arg.toLowerCase() as EffortLevel;
  const h = s.ensureHarness();
  // The efforts are the running harness's (`ultra` is Codex's alone).
  if (!h.caps.effort.includes(effort)) return s.say(`effort: \`${effortOf(s.info)}\`\nchoices: ${h.caps.effort.map((e) => `\`${e}\``).join(', ')}`);
  await Effect.runPromise(h.setEffort(effort));
  s.info.effort = effort;
  s.persist();
  return s.say(`effort → \`${effort}\`${s.isBusy ? ' (from the next step of this turn)' : ''}`);
}

export const speedOf = (info: { speed?: Speed }): Speed => info.speed ?? 'fast';
const SPEEDS: Speed[] = ['fast', 'standard'];

/** `!speed <fast|standard>`: from the next request, mid-turn too, and every later start. */
export async function switchSpeed(s: Pick<ModelHost, 'info' | 'isBusy' | 'say' | 'ensureHarness' | 'persist'>, arg: string) {
  const speed = arg.toLowerCase() as Speed;
  if (!SPEEDS.includes(speed)) return s.say(`speed: \`${speedOf(s.info)}\`\nchoices: ${SPEEDS.map((v) => `\`${v}\``).join(', ')}`);
  await Effect.runPromise(s.ensureHarness().setSpeed(speed));
  s.info.speed = speed;
  s.persist();
  return s.say(`speed → \`${speed}\`${s.isBusy ? ' (from the next step of this turn)' : ''}`);
}
