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

// No action types are registered: the only one (agent_prefill) created a
// Durable Agent Sessions agent, which has been removed. Unknown types render the
// neutral "unsupported link" state.
export const actionHandlers: Record<string, ActionHandler> = {}
