# Telemetry coverage gaps: signup to durable session usage

Status: working review, 2026-06-29.

Scope reviewed:

- `sessions-api`: v3 API, internal worker endpoints, runtime, delivery, sources, Slack/GitHub, telemetry worker.
- `opencomputer`: new dashboard, `api-edge`, `events-ingest`, product/billing workers, TypeScript SDK.

Goal: reconstruct a user's journey with enough precision to answer: who tried what, from which surface, what system accepted it, where it failed or slowed down, which retry/reconcile path ran, and what the user saw next. This must work when a customer mixes dashboard, REST, SDK, webhooks, Slack, GitHub, and session client tokens.

## Current state

The sessions-api telemetry spine is the strongest part:

- `src/v3/telemetry/index.ts` builds bounded, redacted ClickHouse rows and deliberately does **not** gate event names behind a central taxonomy. Keep that. Adding telemetry must not require editing an enum.
- Public `/v3` requests get trace/request ids via `traceMiddleware`, with `api.request.start` / `api.request.end`.
- Runtime, queue, delivery, SSE, source materialization, Slack ingress, GitHub manifest, credentials, and managed model provisioning all have some domain events.
- `agent-telemetry` CF Queue -> telemetry worker -> ClickHouse is best-effort, batched, self-instrumented, and not on the product path.

The weak side is product journey coverage:

- Browser/dashboard currently initializes PostHog and identifies the logged-in user, but does not send a durable event stream to our ClickHouse telemetry spine.
- `api-edge` owns signup/auth, dashboard API, billing, API keys, dashboard -> `/v3` proxying, and sandbox webhook management, but most flows emit only console logs or D1 state changes.
- The TypeScript SDK sends no SDK/version/surface/correlation headers and does not expose response trace ids on thrown errors.
- `/v3` product-level events are uneven: session create/steer/SSE are rich; agent/repo/credential/destination CRUD and read-side activation paths mostly collapse to generic HTTP request telemetry.

## Invariants

1. One correlation vocabulary across dashboard, REST, SDK, edge workers, sessions-api, queues, runtime, and delivery:
   - `trace_id`, `span_id`, `parent_span_id`, `request_id`
   - `client_request_id`
   - `owner_id_hash`, `org_id_hash`, `user_id_hash`
   - `session_id`, `agent_id`, `turn_id`, `event_id`, `delivery_id`, `sandbox_id`
   - `surface`: `dashboard`, `sdk`, `rest`, `client_token`, `slack`, `github`, `worker`, `internal`, `runtime`
   - `sdk_name`, `sdk_version`, `ui_build`, `ui_route` as attrs until they deserve columns
2. No secrets, raw prompts, raw completions, raw repo contents, raw provider keys, bearer tokens, cookies, GitHub tokens, webhook secrets, or long user text in telemetry.
3. Telemetry is never product-correctness critical. It can retry, drop after exhaustion, and self-report loss, but cannot block user work.
4. Product events are free-form dotted names by convention. Do not recreate a central taxonomy gate.
5. Every event should make the next operational question easier. Avoid vanity page events that cannot explain a state transition, failure, or activation drop-off.

## P0: shared correlation across API, SDK, and dashboard

Today, dashboard calls, SDK calls, and raw REST calls can hit the same `/v3` operation but are hard to distinguish and join.

Add client-origin headers:

- Dashboard `apiFetch`:
  - generate `X-OC-Client-Request-Id` per logical request
  - send `X-OC-Surface: dashboard`
  - send `X-OC-UI-Build` when available
  - send `X-OC-UI-Route` as a route template, not concrete ids
  - forward/record returned `x-trace-id` and `x-request-id`
- Dashboard `/api/dashboard/v3/*` proxy:
  - forward `X-OC-Client-Request-Id`, `X-OC-Surface`, `X-OC-UI-Build`, `X-OC-UI-Route`
  - forward an inbound `X-Trace-Id` if present, or mint one at the edge and return it
  - emit edge proxy start/end with upstream status, upstream trace id, duration, caller org/user, and route template
- TypeScript SDK:
  - send `User-Agent: @opencomputer/sdk/<version>`
  - send `X-OC-SDK: typescript`
  - send `X-OC-SDK-Version`
  - send `X-OC-Surface: sdk`
  - generate `X-OC-Client-Request-Id` per request
  - send `X-OC-Client-Attempt` on retries
  - optionally accept an inbound trace id for advanced callers
  - expose `traceId` and `requestId` on `OpenComputerError` from response headers as well as JSON body
- Raw REST:
  - document that callers may pass `X-OC-Client-Request-Id`
  - echo trace/request ids consistently

Server changes:

- `traceMiddleware` should capture these safe headers into telemetry attrs.
- Auth middleware should emit one auth outcome per request, not only selected handlers.
- `api.request.end` should include error envelope `type/code` when available, not only HTTP status.

This is the highest-leverage work because it lets one org's mixed dashboard/SDK/API journey become one traceable graph.

## P0: browser telemetry collector

PostHog alone is not enough for failure reconstruction because it is outside the ClickHouse flight recorder and does not naturally join to backend traces.

Add a small browser telemetry path, preferably a separate CF Worker or a narrow `api-edge` route that can later split out:

- Browser sends to `POST /api/telemetry` with `navigator.sendBeacon` and fetch fallback.
- The collector validates origin/CORS, rate-limits, bounds payload size, redacts, enriches from `oc_session` when authenticated, and sends to a queue.
- The queue lands in ClickHouse, either the existing `agent_telemetry_events` table with `service="web-ui"` / `surface="dashboard"`, or a sibling `product_telemetry_events` table with the same trace fields.
- Unauthenticated events carry an anonymous browser id only. After login, link the anonymous id to hashed user/org in the collector.
- Keep PostHog for product analytics, cohorts, and UI funnels, but use ClickHouse for reconstructing user-visible failures and backend joins.

Minimum browser events:

- `ui.page.view`: route template, org/user when known, build id.
- `ui.action.start` / `ui.action.end`: operation name, entity type, outcome, duration.
- `ui.form.invalid`: field names/error classes only, no values.
- `ui.toast.error`: user-visible error title + safe error class.
- `ui.error.boundary`: component stack hash, route, error name/message head.
- `ui.chunk.reload`: stale chunk reload attempted/succeeded/failed.
- `ui.sse.open` / `ui.sse.close` / `ui.sse.error`: session id, start cursor, last seq, reconnect count.
- `ui.copy`: API key copied, docs/API hint copied/opened; no copied value.

Do not make frontend telemetry depend on PostHog being enabled. The product flight recorder should be first-party.

## P0: edge auth, signup, and activation funnel

`api-edge` owns the first product-critical steps, but most are not in ClickHouse.

Instrument:

- `auth.login.start`: provider, redirect origin.
- `auth.callback.start`: has_code, has_error.
- `auth.workos.exchange`: status, duration, WorkOS error class.
- `auth.user.resolve`: created vs existing.
- `auth.org.resolve`: created vs existing, selected org, personal vs org.
- `auth.session.mint`: success/failure.
- `auth.signup.complete`: new user/org, home cell, billing provider, first org id hash.
- `auth.logout`: result before `posthog.reset()`.
- `auth.refresh`: success/failure, expiry class.

Activation events:

- `api_key.create`: dashboard/API, name_present, scopes, org/user, result.
- `api_key.first_used`: first successful `/api/whoami` or `/v3` call for that key.
- `sdk.first_seen`: first request from an SDK version for an org/key.
- `dashboard.first_v3_action`: first dashboard-proxied v3 mutation.
- `agent.create`, `credential.create`, `session.create`, `session.first_event`, `session.first_completion`.

These should power a view like:

`signup -> API key created -> SDK request -> agent created -> session created -> first turn started -> first user-visible completion`.

## P1: edge and billing system events

Billing and model access are activation-critical. Today `model_billing`, `model_meter`, Autumn/Stripe paths mostly log to console or mutate D1.

Instrument at the edge:

- `billing.customer.create`: provider, new/existing, duration, result.
- `billing.checkout.create`: plan/topup/setup/portal, result, redirect vs direct charge.
- `billing.webhook.received`: provider, event type, signature result.
- `billing.project`: org, halted transition, balance bucket, concurrency tier, duration.
- `billing.self_heal`: triggered, still_halted, provider status.
- `model_billing.enable.start/end`: org, previous status, attempts, OR key created, sessions-api handoff result.
- `model_billing.handoff`: sessions-api status, managed credential id present, duration.
- `model_meter.run.start/end`: org count, billed org count, debited amount bucket, failures.
- `model_meter.org`: per-org result, cap patch result, projected halt state.

Reason: a user can fail to create a managed agent because model billing did not provision, because Autumn failed, because a cap patch failed, or because sessions-api rejected handoff. Those are currently hard to reconstruct end to end.

## P1: `/v3` auth and product-level API events

Public `/v3` generic request telemetry is useful but too low-level for product analysis.

Add or fill gaps:

- Global `auth.check` in org auth middleware:
  - auth kind: `oc_org_key`, `oc_org_token`, `client_token`, `turn_token`, `dev_key`, `missing`, `invalid`
  - resolution: `org`, `per_key`, `invalid`, `unavailable`, `skipped_self_auth`
  - never emit token/key material
- Agent API:
  - `agent.create`, `agent.create.error`, `agent.update`, `agent.read`, `agent.list`
  - attrs: runtime, model, credential mode (`managed`, `byo`, `default`, `inline_key`), created/idempotent, revision
- Credential API:
  - route-level create/rotate/delete/default/list with provider, default flag, backend result
  - core credential emits exist, but route telemetry should capture user-visible validation and HTTP outcomes
- Repo/GitHub API:
  - repos CRUD currently has no emits; add `repo.create/update/list/get`
  - GitHub app emits exist; add read/list and installation preflight outcomes if setup UI depends on them
- Destinations/deliveries API:
  - destination create/update/delete/list, SSRF rejection reason, secret rotated, enabled toggled
  - redelivery requested/accepted/rejected
- Session read/lifecycle:
  - `session.get`, `session.list`, `session.cancel`, `session.archive`, `session.client_token.create`, `session.result.get`, `session.turns.list`
  - session create should emit mapped 422 errors (`runtime_unavailable`, `no_credential`, `managed_unavailable`) before returning; today unknown and conflict paths are richer than these expected failures
- Sources:
  - `session.sources.list`
  - source materialization already emits runner steps; ensure every source row status transition has source name, auth kind, repo identity hash, ref kind, sha mismatch, duration, bytes, retryable

Read events can be sampled later if volume is high, but for launch/activation they are useful. Mutations and errors should not be sampled.

## P1: dashboard action coverage

The dashboard has many React Query mutations that only show toasts on error. Add operation-level instrumentation around them, preferably through a small helper rather than hand-written `posthog.capture` calls everywhere.

Cover:

- Agent create/update/start session from agent detail.
- Session start/steer/cancel/archive/open detail.
- Credential create/rotate/delete/default, including the stepped progress path.
- API key create/revoke/copy once.
- GitHub app setup, repo registration, source status polling once those screens land.
- Slack connect intent/complete/disconnect.
- Webhook create/delete/test/redeliver/reveal secret.
- Billing setup/portal/topup/concurrency/autotopup/promo.
- Org switch, invite, revoke, remove member, custom domain.

Each operation event should include:

- operation name
- route template
- entity type/id when safe
- client request id
- backend trace id/request id if a request happened
- duration
- result: `ok`, `error`, `abandoned`, `validation_error`
- error class/http status, not raw response body

This avoids relying on generic page views to infer intent.

## P1: SDK observability surface

The SDK should not phone home independently. Server-side request telemetry is enough, provided the SDK annotates requests.

Add:

- SDK/version/surface headers.
- Client request id and retry attempt headers.
- Trace/request ids on thrown errors:

```ts
try {
  await oc.sessions.create(...)
} catch (err) {
  if (err instanceof OpenComputerError) {
    console.error(err.requestId, err.traceId, err.code)
  }
}
```

- Optional callback hooks for customer observability, not for our telemetry:
  - `onRequest`, `onResponse`, `onRetry` could be useful later.
  - Avoid adding them unless there is a real user need; headers solve our own reconstruction first.

## P1: session stream and client-token experience

SSE server-side telemetry is better than most areas, but dashboard/client experience is incomplete.

Add:

- Browser `ui.sse.*` events as above.
- SDK `ClientSession.events()` should send SDK headers and track reconnect attempts through `X-OC-Client-Attempt` or query attrs if headers are available.
- Server should include reader kind and auth scope in SSE telemetry: org key, client token, query token, turn token.
- Capture stream close reason, frames sent, replay count, last cursor, duration, and parse/schema errors in dashboard.

This is critical because "the session is stuck" often means "events are flowing but UI dropped the stream" or "the user only saw a stale poll result."

## P2: ClickHouse schema and views

The current wide table is good enough. Use `attributes` for new dimensions first.

Add views once data lands:

- `activation_funnel_by_org`: signup, key, SDK/dashboard action, agent, credential, session, first turn, first completion.
- `org_journey_timeline`: all events for one hashed org/user, including edge/dashboard.
- `api_request_failures_by_surface`: route + surface + SDK version + status/error.
- `dashboard_errors`: route + UI build + error class.
- `billing_journey`: signup through credits/model billing/halt/resume.
- `github_setup_journey`: app link, manifest, callback, install, repo use, source materialize.

Also fix stale schema comments that imply `event_name` is backed by an `EVENT_NAMES` enum. The implementation is intentionally free-form.

## P2: edge worker telemetry helper

Build one small worker-compatible helper shared by `api-edge`, `events-ingest`, and future telemetry collector:

- `emitEdgeTelemetry(env, event)` is best-effort and never throws.
- It bounds/redacts attrs using the same rules as sessions-api.
- It sends full rows to the telemetry queue or a dedicated product telemetry queue.
- It accepts explicit org/user/session ids and hashes where needed.
- It has no central event-name enum.

Do not rely on Tail Workers/Axiom as the product flight recorder. Tail logs are useful for exception backstops, but they are unstructured, console-dependent, and not joined to session traces.

## P2: internal endpoints and scheduled jobs

Internal endpoints now manually adopt trace headers in places, and product-async forwards trace headers. That is acceptable, but make it systematic:

- Add a small internal trace/auth middleware for `/internal/*` that emits request start/end and auth outcome.
- Keep `/internal/managed-credential` separately HMAC-gated, but instrument handoff auth result and replay rejection.
- Product-async scheduled reconciler currently logs scheduled successes/failures; add explicit `reconciler.scheduled.start/end/error` from the worker, plus regional endpoint summaries.
- Include `request_id` in worker-forwarded trace headers, not only trace/span.

## Data safety notes

- Hash raw user ids and org ids before ClickHouse unless they are already opaque and policy says they are safe. Existing sessions-api hashes `owner_id`; edge should mirror that.
- Do not emit email to ClickHouse. PostHog identify may include email for product analytics, but the ClickHouse flight recorder should use ids/hashes.
- Do not emit repo URLs if they can include private org/repo names unless we explicitly accept that. Prefer repo id or a stable hash; if clear `owner/repo` is needed for ops, decide deliberately.
- Do not emit webhook URLs, provider keys, GitHub tokens, cookies, WorkOS tokens, OpenRouter keys, prompts, completions, or message bodies.
- Error messages should be bounded and classified. Raw upstream bodies should be avoided unless redacted and capped.

## First implementation slice

1. Add `client_request_id`, `surface`, SDK/version, UI build/route propagation through dashboard, SDK, api-edge proxy, and sessions-api telemetry attrs.
2. Add the browser telemetry collector path and wire `apiFetch`, ErrorBoundary, route views, action helper, and SSE events.
3. Add edge auth/signup/billing/model-billing emits through a shared edge telemetry helper.
4. Fill `/v3` product gaps for auth middleware, agent/repo/credential/destination/session lifecycle expected errors.
5. Add ClickHouse views for activation and surface failures.

This slice is enough to reconstruct:

- user signs up
- user creates/copies an API key
- SDK or dashboard creates an agent
- credential/model billing resolves or fails
- session starts
- source checkout/runtime starts
- first turn completes, hangs, crashes, or fails to emit
- UI stream renders, disconnects, or errors

## Open questions

- Should browser telemetry and backend telemetry share `agent_telemetry_events`, or should browser/product telemetry have a sibling table with identical correlation fields? Sharing is simpler for joins; a sibling table keeps high-volume UI events from crowding runtime ops.
- How much anonymous pre-login UI behavior do we care to keep in ClickHouse versus PostHog only?
- Do we want raw org ids in ClickHouse for internal support convenience, or always hashed ids with a lookup in D1 when needed?
- Should dashboard route/pageview events be sampled after launch, while mutations/errors remain unsampled?
