# Changelog

## 2.1.2

- `@opencomputer/sdk/agents`: the transport called `fetch` as a method of the client, which a native fetch refuses with `Illegal invocation` in workerd; it is now called as a plain function. Found by the Development proof of a Worker without Node compatibility. No API change.

## 2.0.0

Breaking. The `OpenComputer` class that wrapped the Durable Agent Sessions
API at `api.opencomputer.dev/v3`, `connectSession`, and their agents,
sessions, credentials, repos, GitHub apps, hooks, watches, schedules and
destinations resources are removed. Customers of that API pin the last
published version that has it, `1.1.1`.

- `@opencomputer/sdk/agents` is a new subpath export: the
  `OpenComputer` client for the Serverless Agents management API at
  `app.opencomputer.dev/api/managed-agents`, mirroring the documented routes
  (`sessions`, `sessions.turns`, `sessions.events`, `projects`,
  `projects.memory`, `projects.webhooks`, `projects.eventSubscriptions`,
  `projects.github`, `agents`, `deployments`), with one `OpenComputerError`
  of `{ code, status, message }`, plus `retryAfter` from a `429` and
  `sessionId` when the API tied the failure to a session
  (`session_publication_unconfirmed`). The client retries nothing and follows
  no redirect. Its module graph has no Node dependency and runs nothing at
  import, so it loads in Cloudflare Workers without Node compatibility.
- `startSessionOnDocument`, the memory types and the event subscription types
  move to that subpath; `oc.sessions.startOnDocument` is the same call on the
  client. Its `NotFoundError` and `ConflictError` become `OpenComputerError`
  with codes `memory_document_deleted` and `idempotency_key_reused`.
- The package root keeps the sandbox client and `verifyWebhook`. Importing it
  no longer replaces Node's global fetch dispatcher and no longer opens
  connections: the sandbox client owns its HTTP/2 pool and passes it to each
  request, creates it on the first request, and warms it on the first
  `Sandbox.create`. Programs that measured creates after a bare import call the
  exported `prewarmConnections()` before their loop.
