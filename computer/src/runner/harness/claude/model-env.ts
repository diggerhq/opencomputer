// Claude Code's model adapter (work 097, design C5): what a model profile's
// `harness.claude` object means for the environment Claude Code is spawned
// from. Claude Code talks to the model proxy's API socket in its tunnel mode
// (ANTHROPIC_UNIX_SOCKET under Anthropic's base URL) and holds only the
// placeholder, in the variable the profile's `tokenEnv` names; the proxy puts
// the credential on each request.
//
// Invariants:
// - No credential value is ever set here: every Claude credential variable is
//   the placeholder, '' or unset (the env test in model-env.test.ts).
// - The object is validated whole: an unknown field or another `tokenEnv` is
//   malformed, and malformed sets nothing (model-access.ts refuses the turn).

import { z } from 'zod';
import { type CacheTtlSettings, applyPromptCacheTtl } from '../../cache-ttl.js';

/** The profile's `harness.claude` (design C5, C7). */
export const ClaudeModel = z.strictObject({
  /** The variable Claude Code reads its credential from: here, the placeholder. */
  tokenEnv: z.enum(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']),
  /** Claude Code's prompt cache TTL on this route (cache-ttl.ts), e.g. `1h`. */
  promptCacheTtl: z.string().min(1).optional(),
  /** A refused model steps down a family and the turn is retried (model-downgrade.ts). */
  downgradeOnModelRefusal: z.boolean().optional(),
});
export type ClaudeModel = z.infer<typeof ClaudeModel>;

/** Every variable Claude Code may take a credential or an endpoint from. */
export const CLAUDE_MODEL_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_UNIX_SOCKET',
] as const;

/** Point Claude Code in `env` at the proxy's socket `unixSocket`, with `placeholder` in `m.tokenEnv`. */
export function claudeModelEnv(env: NodeJS.ProcessEnv, m: ClaudeModel, unixSocket: string, placeholder: string, ttl: CacheTtlSettings) {
  for (const k of CLAUDE_MODEL_VARS) delete env[k];
  env.ANTHROPIC_BASE_URL = 'http://api.anthropic.com';
  env.ANTHROPIC_UNIX_SOCKET = unixSocket;
  // Remote settings and other extras would go direct, around the socket.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env[m.tokenEnv] = placeholder;
  // A bearer token with an empty API key, so that none is sent in its place.
  if (m.tokenEnv === 'ANTHROPIC_AUTH_TOKEN') env.ANTHROPIC_API_KEY = '';
  applyPromptCacheTtl(env, ttl, m.promptCacheTtl);
}

/** No route: none of the model variables (a spare claimed for Codex). */
export function clearClaudeModelEnv(env: NodeJS.ProcessEnv) {
  for (const k of CLAUDE_MODEL_VARS) delete env[k];
}
