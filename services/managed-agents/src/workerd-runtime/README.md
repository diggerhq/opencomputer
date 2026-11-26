# Workerd managed-agent runtime

This Worker hosts one OpenCode model loop per session Durable Object. The
managed edge session owns the public session contract and delegates model turns
to this runtime. Effectful tools acquire a sandbox lazily through
the private sandbox service binding; the model loop remains in the Durable
Object when the sandbox is terminated.

`wrangler.workerd.jsonc` is the production configuration. Keep the
`OpenCodeSessionDurableObject` export, namespace binding, and migration tag
stable: existing production Durable Objects are addressed through that class.

The runtime is an internal service-bound Worker. It does not expose a public
demo or a second user-facing API.

The runtime has an isolated package lock because its pinned Workerd SDK and the
MicroVM harness currently use incompatible OpenCode release trains. Install it
with `npm ci --prefix src/workerd-runtime` before checking or bundling from a
fresh checkout. Remove this boundary only after both harnesses share one
OpenCode dependency graph.

## Turn execution fence and Stop

`POST /sessions/:id/turn` claims a turn lease for the OpenCode session before
the prompt is admitted (`workerd_turn_lease`, keyed by OpenCode session id,
carrying the managed turn id). Only the loop's own terminal execution event
or `POST /sessions/:id/interrupt` releases it; a cancelled turn stream does
not, because the loop it observed may still be running. While a lease is held,
or while OpenCode reports the session's loop as active, `/turn` answers
`409 { error: "turn_in_progress", turnId }` before `sessions.prompt` (the
pinned SDK defaults a new prompt to steering into the running loop). The
managed session treats that as "interrupt first, then retry", never as a
fresh admission. `/interrupt` boots OpenCode when a lease is still held, so
a turn the boot-time sweep replays after an eviction is stopped rather than
raced; it answers 409 with `active: true` if the loop is still reported
running afterwards, and the caller retries.

Interrupting the model loop does not cancel a computer command that was
already dispatched to the sandbox and does not undo its effects: the command
runs to completion or to its own timeout. Stop bounds the model's next
action, not the effects of the one in flight.

## Project memory

`memory-client.ts` is the one seam between this host and project memory: a
`MemoryClient` scoped to one managed session's grants in one Memory Durable
Object, reached through the `MEMORY` namespace binding (the edge worker's
`MemoryDurableObject`, bound with `script_name`). The session Durable Object
recalls every bound resource before each render, pins what the request saw as
`workerd_request_snapshot` rows in the render's transaction, exposes the fixed
tools `memory_save`, `memory_read` and `memory_list` only for the resources the
render selected with `useMemory`, and emits `opencomputer.memory.saved` on the
turn stream after a committed save.

The host cannot yet attribute a tool call to the render that produced it (the
pinned cohort's context hook carries no `messageID`; the request snapshot is
keyed by render id and a tool call maps to the session's latest render, which
also runs during compaction). The mitigation: each render records the
assistant message ids already present in the context hook's `messages`
(`workerd_seen_messages`); a memory tool call whose execute-context
`messageID` is in that set belongs to an earlier render and is answered
`{ status: "rejected", reason: "stale" }` instead of touching the latest
snapshot.

`test/workerd-memory.test.ts` (vitest project `workerd-memory`) drives the real
Durable Object with a scripted client. `npm run bundle` then
`npm run smoke:memory` runs the bundled runtime with the real OpenCode loop in
Miniflare against a mocked model and `smoke-memory-do.mjs` in place of the
Memory Durable Object.

