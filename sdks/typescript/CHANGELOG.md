# Changelog

## 2.3.0

- `@opencomputer/sdk/agents`: questions. `Session.question` is the question
  the agent asked with `ask`, or `null` (`SessionQuestion`); a turn that
  ended by asking completes with `outcome: "question"` (`TurnOutcome`).
  `turns.send(id, { input, answers: questionId })` answers it; naming a
  question that is not the open one is `409 question_stale`.
  `sessions.questions.dismiss(id, questionId)` closes it without an answer.
- `TurnReceipt` is now a union: `AdmittedTurnReceipt` (`turnId`, `status`,
  `duplicate`) or `HeldTurnReceipt` (`status: "held" | "discarded"`,
  `questionId`, `duplicate`, no `turnId`) for input sent while a question is
  open without answering it. Code that read `receipt.turnId` as a string
  narrows on it first (`if (receipt.turnId !== undefined)`); a session that
  never asks returns only admitted receipts. The React hook's matching
  change is `@opencomputer/react` 0.4.0, where `SendReceipt.turnId` becomes
  optional and `questionId` is set on a held receipt.
- A turn queued when a question was asked settles as `cancelled` with
  `reason: "held"` and `questionId`, on the turn and on its `turn.cancelled`
  event (`discarded: true` when a stop dropped its input).
- Events: `question.asked`, `question.answered`, `question.closed` with
  `reason` `stopped | dismissed | ended | undeliverable`
  (`QuestionClosedReason`); `message.held`, then `message.delivered` or
  `message.discarded`, for each held input; `delivery.failed` for a channel
  activity the platform could not post.

## 2.2.0

- `@opencomputer/sdk/agents`: `sessions.list` takes exact filters
  (`SessionFilters`: `projectId`, `environment`, `agentId`, `status`, `deploymentId`,
  `externalReference`, `createdAfter`, `createdBefore`, `updatedAfter`,
  `labels`) and a `cursor`, and returns `nextCursor` (`null` on the last
  page); `sessions.iterate` walks every page. `externalReference` on
  `sessions.create` is your opaque reference to the session, returned on
  the session, its list row and its `session.*` events, and part of the
  creation identity.

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
