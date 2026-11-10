// The harnesses a computer can run (work 082), as data.
//
// A harness is the coding agent a session runs (protocol.ts CalvinHarness).
// What this computer can run comes from the features its host listed in its
// latest hello, which the ComputerDO keeps across park and disconnect: each
// harness needs one feature, or none (HARNESS_REQUIRES). A computer whose host
// has never said hello (onboarding picks the agent before the Slack install
// creates it) gets every harness: it will boot the current release, whose
// proxy serves them all. No configuration: the hosts are the only source.
//
// Nothing writes a subscription row for a harness this computer cannot run
// (ModelSubscriptions.refuseHarness, and the backstop in `newRow`): blue from
// before #272 reads rows by owner alone, so a rollback must find none for a
// harness it does not know.

import type { CalvinHarness, ModelProvider } from "./protocol.js";

/** The feature a host's hello lists when ChatGPT routes may go to it (with protocol 3). */
export const MODEL_PROXY_CHATGPT_FEATURE = "model-proxy/chatgpt";

/** Every harness blue knows, in the order the agent view lists them. */
export const HARNESSES: readonly CalvinHarness[] = ["claude", "codex"];
/** The harness a session runs unless something chose another. */
export const DEFAULT_HARNESS: CalvinHarness = "claude";

/** The host feature each harness needs; null: every host runs it. */
export const HARNESS_REQUIRES: Record<CalvinHarness, string | null> = {
  claude: null,
  codex: MODEL_PROXY_CHATGPT_FEATURE,
};

/** How people read each harness's name. */
export const HARNESS_NAMES: Record<CalvinHarness, string> = {
  claude: "Claude",
  codex: "Codex",
};

const HARNESS_OF_PROVIDER: Record<ModelProvider, CalvinHarness> = {
  anthropic: "claude",
  chatgpt: "codex",
};

/** The harness a subscription row's provider is for. */
export function harnessOf(provider: ModelProvider): CalvinHarness {
  return HARNESS_OF_PROVIDER[provider];
}

/** The provider whose rows a harness runs on. */
export function providerOf(harness: CalvinHarness): ModelProvider {
  return harness === "codex" ? "chatgpt" : "anthropic";
}

export function isHarness(value: unknown): value is CalvinHarness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** A new thread's optional harness override. Leave model tiers for the runner. */
export function takeHarnessPrefix(text: string): { harness?: CalvinHarness; text: string } {
  const match = /^\s*\+(claude|codex)(?=\s|$)\s*/i.exec(text);
  return match ? { harness: match[1]!.toLowerCase() as CalvinHarness, text: text.slice(match[0].length) } : { text };
}

/**
 * The harnesses this computer can run: those whose feature `features`, the
 * host's latest recorded hello, lists; every one when never heard from.
 */
export function computerHarnesses(features: readonly string[] | undefined): CalvinHarness[] {
  if (!features) return [...HARNESSES];
  return HARNESSES.filter((h) => {
    const needs = HARNESS_REQUIRES[h];
    return needs === null || features.includes(needs);
  });
}

export const HARNESS_UNAVAILABLE_CODE = "computer_harness_unavailable";

/** The refusal of a connection for a harness this computer cannot run: nothing was written. */
export function harnessUnavailable(harness: CalvinHarness): { status: 409; code: typeof HARNESS_UNAVAILABLE_CODE; message: string } {
  return { status: 409, code: HARNESS_UNAVAILABLE_CODE, message: `${HARNESS_NAMES[harness]} isn't available on this computer yet` };
}
