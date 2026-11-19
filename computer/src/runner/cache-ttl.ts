// Claude Code's prompt cache TTL (CLAUDE_CODE_PROMPT_CACHE_TTL, and the
// subagent one), decided where a process starts and again when its model
// route arrives; the harness copies the environment when it spawns.
//
// Why a profile asks for 1 hour: on an API key Claude Code caches for 5
// minutes, and telemetry showed every turn after a longer pause re-writing the
// whole 190–330k-token conversation, 11–14 s to the first token. 1-hour cache
// writes cost 2× base input instead of 1.25×; one avoided rewrite pays for it.
// Which endpoints take it is the model profile's to say (its Claude Code
// `promptCacheTtl`, work 097 C5), not something guessed from a base URL.
//
// Order: SP_PROMPT_CACHE_TTL, then what the process was started with (the
// preset), then the profile's `promptCacheTtl`, else Claude Code's default.

const VARS = ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'] as const;

export type Ttls = Partial<Record<(typeof VARS)[number], string>>;

/** SP_PROMPT_CACHE_TTL and the preset, as runner/main.ts read them at start. */
export interface CacheTtlSettings {
  explicit: string | undefined;
  preset: Ttls;
}

/** Both TTL variables for a route whose profile asks for `profile`; undefined leaves Claude Code's default. */
export function promptCacheTtls(o: CacheTtlSettings, profile: string | undefined): Record<(typeof VARS)[number], string | undefined> {
  return Object.fromEntries(VARS.map((k) => [k, o.explicit || o.preset[k] || profile])) as Record<(typeof VARS)[number], string | undefined>;
}

/** Set (or clear) both TTL variables in `env`. */
export function applyPromptCacheTtl(env: NodeJS.ProcessEnv, o: CacheTtlSettings, profile: string | undefined) {
  for (const [k, v] of Object.entries(promptCacheTtls(o, profile))) {
    if (v) env[k] = v;
    else delete env[k];
  }
}

/** The TTL variables as the process found them, before any were set here. */
export const presetTtls = (env: NodeJS.ProcessEnv): Ttls => Object.fromEntries(VARS.flatMap((k) => (env[k] ? [[k, env[k]]] : [])));
