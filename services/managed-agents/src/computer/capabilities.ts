// What a session may use (work 084; objects.mdx#capabilities): models, efforts, permission modes
// and features. Nobody downstream validates a model or mode (calvin passes them to the harness),
// so blue owns this list and checks create and PATCH against it. Static: it changes with a
// release, not per request, so reads are free. The organization's default model is the first.

import type { CalvinMode } from "./protocol.js";

export interface CapabilityModel {
  id: string;
  name: string;
  efforts: string[];
  contextWindow: number | null;
  default: boolean;
}

export interface Capabilities {
  models: CapabilityModel[];
  modes: string[];
  features: { steer: boolean; compact: boolean; terminal: boolean; workspace: boolean; reasoning: boolean; subagents: boolean };
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** calvin's DEFAULT_MODEL first; the models its harnesses run. */
export const MODELS: readonly CapabilityModel[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: EFFORTS, contextWindow: 1_000_000, default: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: EFFORTS, contextWindow: 1_000_000, default: false },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: ["low", "medium", "high"], contextWindow: 200_000, default: false },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: EFFORTS, contextWindow: 1_000_000, default: false },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol (Codex)", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 400_000, default: false },
];

export const MODES: readonly CalvinMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

/** The mode a session gets when none is asked for: what Slack sessions run with. */
export const DEFAULT_MODE: CalvinMode = "bypassPermissions";

const CAPABILITIES: Capabilities = {
  models: MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })),
  modes: [...MODES],
  features: { steer: true, compact: true, terminal: true, workspace: true, reasoning: true, subagents: true },
};

export function capabilities(): Capabilities {
  return CAPABILITIES;
}

/** The modes a plan approval's answer may switch to (calvin asks.ts PLAN_EXIT_MODES). */
export const PLAN_EXIT_MODES: readonly string[] = ["default", "acceptEdits", "auto", "bypassPermissions"];
export const isMode = (mode: unknown): mode is CalvinMode => typeof mode === "string" && (MODES as readonly string[]).includes(mode);

export function modelOf(id: string | null | undefined): CapabilityModel | undefined {
  return id ? MODELS.find((m) => m.id === id) : undefined;
}

export type SettingsRefusal = { code: "unsupported_model" | "unsupported_effort" | "unsupported_mode"; field: "model" | "effort" | "mode"; message: string };

/**
 * Checks requested settings against the list. `effort` is checked against the new model when both
 * are sent, else against `currentModel` (or the default). Returns the effort to store: a model
 * change resets an effort the new model does not accept to null (its default).
 */
export function checkSettings(
  input: { model?: string; effort?: string; mode?: string },
  current: { model: string | null; effort: string | null } = { model: null, effort: null },
): { ok: true; effort: string | null | undefined } | ({ ok: false } & SettingsRefusal) {
  if (input.model !== undefined && !modelOf(input.model)) {
    return { ok: false, code: "unsupported_model", field: "model", message: `model must be one of ${MODELS.map((m) => m.id).join(", ")}` };
  }
  if (input.mode !== undefined && !isMode(input.mode)) {
    return { ok: false, code: "unsupported_mode", field: "mode", message: `mode must be one of ${MODES.join(", ")}` };
  }
  const model = modelOf(input.model ?? current.model) ?? MODELS[0]!;
  if (input.effort !== undefined) {
    if (!model.efforts.includes(input.effort)) {
      return { ok: false, code: "unsupported_effort", field: "effort", message: `${model.id} accepts effort ${model.efforts.join(", ")}` };
    }
    return { ok: true, effort: input.effort };
  }
  if (input.model !== undefined && current.effort && !model.efforts.includes(current.effort)) return { ok: true, effort: null };
  return { ok: true, effort: undefined };
}
