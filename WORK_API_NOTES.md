# Work API: deviations from tech-design 3.2, 3.6 and 3.10

Build step 3, the service side. Each point below is a place where the code differs from the design text, or where the design was ambiguous and the simplest reading was chosen.

## Read routes (as built)

- `GET /work/repository` returns `{ repository: { installationId: string, owner, name, branch, problem: string | null } | null }`.
- `PUT /work/repository` returns the same shape.
- `GET /work/items?stage=open` returns `{ repository, head, asOf, building, items: Item[] }` and an `ETag` header.
- `GET /work/items?stage=closed[&cursor&limit]` returns `{ items: Item[], nextCursor: string | null }`.
- `GET /work/items/{n}` returns `{ item: Item, body: string }`.
- `GET /work/items/{n}/history[?cursor]` returns `{ revisions: [{ sha, url, at, authorName, summary, sessionId: string | null }], nextCursor }`.
- Errors use the usual envelope: `{ error: { code, message, requestId, retryable, ... } }`.

## Contract deviations

- `Item.sessions[]` is `{ id, title, ownerName, status }`. The `status` field is added; the web client treats it as optional.
- `unpublished` is always `false`. Unpublished work (3.7) is not built yet.
- The `attention` of an item comes only from open asks:
  - `needs_you`: the caller's session with the oldest open ask;
  - `waiting_on`: another person's session with the oldest open ask;
  - `working`: a running or starting session, using the latest activity.

  `name` is the session owner's name, including for `needs_you`.
- The ETag is `"<head|none>-<sha256/16 of the page without asOf>"`. It covers the whole page, not just head plus attention, because PR state and people names change without a commit. On a 304 the client keeps its earlier `asOf`.
- `stage` is required. `stage=open` returns everything and refuses `cursor` and `limit` with a 400. For `stage=closed`, items come highest number first; the default `limit` is 50 and the maximum is 100.
- Unknown query parameters and unknown PUT fields return 400 `invalid_request`, with `field` set.
- `installationId` is a string. A PUT accepts a string or a positive integer.
- `Idempotency-Key` is validated on PUT but not stored, because the PUT is naturally idempotent.
- `setRepository` errors are 400 `invalid_request` with `reason` and `field`, or 503 `unavailable`. An unbound `WORK_INDEX` is 503 with `retryAfterMs` 5000.

## Composition

- The design names two Computer-object calls, `briefs` and `people`. They are one `work.context` op, so a page costs one round trip. It returns `{ sessions, people, callerEmails }`.
- Briefs carry `status` and `openAskAt`, not the 3.7 attention, aside or unpublished fields.
- `mine` is true when the item owner's email is in `callerEmails`. `callerEmails` holds:
  - the email the edge asserted;
  - the `owner_email` of the caller's sessions;
  - the `people.git_email` linked to the caller's sessions.

  Emails matching "noreply" are dropped.
- Other people's private Slack sessions are left out of `items[].sessions` and out of history. Their `sessionId` is null. A trailer that names a Slack runner key is mapped to the public session id.
- To provide `user_email` and `user_name`, the edge now asserts them for dashboard (cookie) callers too, from `users` joined to `org_memberships`.

## Scopes

- The new scopes are `work:read` (all GETs) and `work:write` (PUT).
- Both are named-only, like `secrets:write`. Wildcard, legacy and `sandbox:*` keys do not get them. The dashboard gets every scope.
- The edge's `KEY_SCOPES` and `COMPUTER_SESSION_KEY_SCOPES` are unchanged, so keys created by the CLI or a session lack the work scopes until someone decides they should have them.
- A session principal can read but is refused on PUT (`computer_principal`).

## Index (3.2, 3.6)

- The index has an extra `files` table. When two files claim the same number, the open file wins, then the lowest path.
- During the build, each item makes one `commits?per_page=1` call to get `updatedAt`.
- During advance, per-commit details are fetched for adds and renames, capped at 20 per advance.
- `closed_by` is null for session commits.
- PR state is read with a separate installation-wide `pull_requests` token. An unreadable PR is treated as final and has state `null`.
- History follows only the item's current slug, not renames.
- `knowledgeRepository(env, orgId)` takes `env` as well.

## Remaining

- A Work API docs page. The scope rows were added to `docs/api/overview.mdx`.
- OpenAPI: none exists in the repo.
- SDK types.
- Grafana panels for the new `work` route family.
- Whether `KEY_SCOPES` should include `work:read`.

## [V] items

Nothing was verified against live GitHub or Slack.

- Line 131 (the ids in Slack session trailers): either form works, because the server resolves runner keys.
- Line 175 (the App's contents-write grant): not needed for step 3.
- Line 177 (GraphQL with an installation token): exercised only against the fake GitHub.
- Line 231 (plain proxy call): not part of this step.
