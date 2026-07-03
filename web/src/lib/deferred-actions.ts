// Deferred actions — deeplink intents that survive signup.
//
// An action is a versioned, typed envelope base64url-encoded into the `action`
// query param on the /do route. The URL is the store: no server-side intent
// table, no TTL. Attribution params (utm_*, gclid, …) ride as SIBLING query
// params next to `action`, never inside the envelope, so tracking tools read
// them from their standard positions.
//
// Design + rationale: opencomputer .agents/work/deferred-actions.md
import { z } from 'zod'
import { createAgent } from '@/api/client'
import { DEFAULT_RUNTIME, defaultModelFor } from '@/lib/runtimes'

export const ActionEnvelopeSchema = z.object({
  v: z.literal(1),
  type: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
})
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>

// Unicode-safe base64url. btoa/atob operate on binary strings, so we round-trip
// through UTF-8 bytes — a naive btoa(JSON.stringify(...)) throws on emoji/CJK.
// This is the reference encoder: the launch site mints /do?action= URLs with
// the identical algorithm, so keep them byte-compatible.
export function encodeAction(envelope: ActionEnvelope): string {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Returns null on ANY malformed input (bad base64, bad JSON, schema miss) so
// callers render one neutral "unsupported link" state.
export function decodeAction(raw: string): ActionEnvelope | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const res = ActionEnvelopeSchema.safeParse(parsed)
    return res.success ? res.data : null
  } catch {
    return null
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────
// Each returns where to navigate on success. Add a new action type by adding a
// schema + a handler here and registering it below.

export type ActionResult = {
  navigateTo: string
  navigateState?: unknown
  // Extra props merged into the deferred_action_executed event (e.g. agent_id).
  analytics?: Record<string, unknown>
}
export type ActionHandler = (params: unknown) => Promise<ActionResult>

// Cap kept in sync with the edge safeReturnTo length limit — a longer prompt
// would make the /do?action= URL exceed what round-trips through WorkOS `state`
// on the anonymous signup path (see cloudflare-workers/api-edge/src/index.ts).
export const AgentPrefillParamsSchema = z.object({
  prompt: z.string().trim().min(1).max(1000),
})

// Deterministic agent name from the prompt so a retry — or the same link
// clicked twice — resolves to the SAME (owner, name) and the create-or-get
// endpoint returns the existing agent instead of spawning a duplicate.
// /v3/agents dedupes on (owner, name); it has no idempotency-key path.
function deriveAgentName(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  let h = 0
  for (let i = 0; i < prompt.length; i++) h = (Math.imul(h, 31) + prompt.charCodeAt(i)) | 0
  const suffix = (h >>> 0).toString(36)
  return `${slug || 'agent'}-${suffix}`
}

// agent_prefill: create the agent (managed billing — free, zero-config for a
// fresh org) and land on its sessions tab with the composer prefilled. It does
// NOT start a session — the first turn spends credits, so it waits for an
// explicit keypress. This also makes drive-by links harmless (a hostile link
// can create a free agent at worst, never spend money).
const agentPrefill: ActionHandler = async (params) => {
  const { prompt } = AgentPrefillParamsSchema.parse(params)
  const agent = await createAgent({
    name: deriveAgentName(prompt),
    prompt,
    model: defaultModelFor(DEFAULT_RUNTIME),
    runtime: DEFAULT_RUNTIME,
    credential: 'managed',
  })
  return {
    navigateTo: `/agents/${agent.id}/sessions`,
    navigateState: { composerPrefill: prompt },
    analytics: { agent_id: agent.id },
  }
}

export const actionHandlers: Record<string, ActionHandler> = {
  agent_prefill: agentPrefill,
}
