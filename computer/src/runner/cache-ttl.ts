// Claude Code's prompt cache TTL (CLAUDE_CODE_PROMPT_CACHE_TTL, and the
// subagent one), decided where a process starts and again whenever its Claude
// endpoint changes; the harness copies the environment when it spawns.
//
// Why 1 hour: on an API key Claude Code caches for 5 minutes, and telemetry
// showed every turn after a longer pause re-writing the whole 190–330k-token
// conversation, 11–14 s to the first token. 1-hour cache writes cost 2× base
// input instead of 1.25×; one avoided rewrite pays for it.
//
// Only on Anthropic's own API by default: through an Anthropic-compatible
// endpoint (an organization's OpenRouter key, work 052) the 1-hour TTL is
// documented by OpenRouter (`cache_control.ttl: "1h"` on its Messages API)
// but untested with Claude Code, which also sends the
// `extended-cache-ttl-2025-04-11` beta. There it stays Claude Code's default
// unless SP_PROMPT_CACHE_TTL is set.

const VARS = ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'] as const;

type Ttls = Partial<Record<(typeof VARS)[number], string>>;

/**
 * Both TTL variables for an endpoint (`baseUrl` unset: Anthropic's own);
 * undefined leaves Claude Code's default. `explicit` (SP_PROMPT_CACHE_TTL)
 * wins, then what the process was started with (`preset`).
 */
export function promptCacheTtls(explicit: string | undefined, preset: Ttls, baseUrl: string | undefined): Record<(typeof VARS)[number], string | undefined> {
  // A subscription's tunnel (work 077) names Anthropic's own API over the proxy's socket.
  const dflt = !baseUrl || /^https?:\/\/api\.anthropic\.com\/?$/.test(baseUrl) ? '1h' : undefined;
  return Object.fromEntries(VARS.map((k) => [k, explicit || preset[k] || dflt])) as Record<(typeof VARS)[number], string | undefined>;
}

/** Set (or clear) both TTL variables in `env` for its current endpoint. */
export function applyPromptCacheTtl(env: NodeJS.ProcessEnv, explicit: string | undefined, preset: Ttls) {
  for (const [k, v] of Object.entries(promptCacheTtls(explicit, preset, env.ANTHROPIC_BASE_URL))) {
    if (v) env[k] = v;
    else delete env[k];
  }
}

/** The TTL variables as the process found them, before any were set here. */
export const presetTtls = (env: NodeJS.ProcessEnv): Ttls => Object.fromEntries(VARS.flatMap((k) => (env[k] ? [[k, env[k]]] : [])));
