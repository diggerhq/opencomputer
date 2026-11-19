# Work API: as built, and where it differs from tech-design 1, 2, 3.2, 3.6, 3.10, 4 and 5

Build step 3, the service side. This file covers the shapes and headers, how the index follows the repository, what each operation costs in GitHub calls, and each place where the code differs from the design text or where the design was ambiguous and the simplest reading was chosen.

## Shapes

- `Repository` is `{ installationId: string, owner, name, branch, problem: string | null, problemMessage: string | null }`.
  - `problem` is a stable code: `repository_not_found`, `branch_not_found`, `access_denied`, `installation_removed`, `unavailable`.
  - `problemMessage` is GitHub's words, for people.
- `GET /work/repository` returns `{ repository: Repository | null }`.
- `PUT /work/repository` returns the same shape.
- `GET /work/repositories` returns, for the repository picker, `{ installations: [{ id, accountLogin, accountType, settingsUrl, repositories: [{ id, owner, name, private, defaultBranch, pushedAt: string | null }], truncated, problem, problemMessage }] }`.
  - One entry per active GitHub installation of the organization, in one call. `id` is the value `PUT /work/repository` takes as `installationId`.
  - `settingsUrl` is the installation's page on GitHub (`/organizations/<login>/settings/installations/<id>`, or `/settings/installations/<id>` for a user), built here so the web derives nothing.
  - Repositories are sorted by `pushedAt`, newest first, never-pushed last, then by name. At most 500 per installation are read; `truncated` says more exist. The cap applies in GitHub's order, before the sort, so with more than 500 the newest may be among those left out.
  - An installation GitHub reports gone or suspended comes back with its `problem` and no repositories. GitHub not answering is 503 `unavailable`.
  - Nothing is stored and the index's write chain is not used; the installation tokens are cached as for the index's own reads. Scope: `work:read`.
- `GET /work/items?stage=open` returns `{ repository, head, asOf, building, items: Item[] }`, with an `ETag` header.
- `GET /work/items?stage=closed[&cursor&limit]` returns `{ items: Item[], nextCursor: string | null }`.
- `GET /work/items/{n}` returns `{ item: Item, body: string }`.
- `GET /work/items/{n}/history[?cursor]` returns `{ revisions: [{ sha, url, at, authorName, summary, sessionId: string | null }], nextCursor }`.
  - Newest first, 30 per page.
  - The cursor is a keyset on `(at, sha)`.
- In `Item`:
  - `updatedAt`, `createdAt`, `closedAt` and `closedBy` are null until the walk (below) has read the commit that settles them. They are never a placeholder date.
  - A move to `done/` that has not been dated yet leaves `closedAt` and `closedBy` null. They are not taken from the newest commit.
- Errors use the usual envelope: `{ error: { code, message, requestId, retryable, ... } }`.
  - A read that needs GitHub and does not get an answer within 5 s is 503 `unavailable` with `retryAfterMs`, plus a `Retry-After` header. This covers a closed item's body read for the first time, and history before the walk is done.

## Headers

- `ETag` on the open list.
  - It is `"<head|none>-<sha256/16 of [index version, sessions stamp, caller member, caller email]>"`.
  - The index version moves on every write that changes output, including pull request state.
  - The sessions stamp is a counter in the Computer object (`work_stamp`). AFTER INSERT/UPDATE/DELETE triggers on `sessions` and `people` move it, so every write moves it, including the ones that leave `updated_at` alone (for example an `owner_name` change). Triggers were chosen so that no write path can forget to bump it.
  - The tag is checked before the list is read or composed. An unchanged poll costs two stamp calls (the index and the Computer object) and no SQL beyond them.
- `Work-As-Of` is the time the index last saw the branch head. It is on every Work read, 200 and 304. On a 304 the client keeps its body and takes the new `Work-As-Of`.
- The api-edge forwards `Work-As-Of` back and exposes it to CORS (`cloudflare-workers/api-edge/src/computer_api.ts`). `Idempotency-Key` was already forwarded and allowed.
- `Idempotency-Key` is validated on PUT but not stored, because the PUT is naturally idempotent.

## Requests

- `stage` is required.
  - `stage=open` returns everything and refuses `cursor` and `limit` with a 400.
  - For `stage=closed`, items come highest number first. The default `limit` is 50 and the maximum is 100.
- Unknown query parameters and unknown PUT fields return 400 `invalid_request`, with `field` set.
- The PUT body:
  - `installationId` is a string; a PUT accepts a string or a positive integer;
  - `owner` is a GitHub login;
  - `name` uses GitHub's repository charset (`[A-Za-z0-9._-]`, not `.` or `..`);
  - `branch` follows `git check-ref-format --branch` (`branchName` in `api.ts`).
- `owner` must be the installation's account (`accountLogin` from the Account object's `getGitHubInstallation`). Otherwise the PUT is 400 `invalid_request` with `field: "owner"` and `reason: "owner_mismatch"`.
- A stored problem never refuses a PUT. The PUT checks the repository afresh and clears the problem.
- Other `setRepository` errors are 400 `invalid_request` with `reason` and `field`, or 503 `unavailable`.
- An unbound `WORK_INDEX` is 503 with `retryAfterMs` 5000.
- **Decision for the owner:** any member may set the repository, as the design says. Nothing narrows it to admins.

## Contract deviations

- `Item.sessions[]` is `{ id, title, ownerName, status }`. The `status` field is added; the web client treats it as optional.
- `unpublished` is always `false`. Unpublished work (3.7) is not built yet.
- The `attention` of an item comes only from open asks:
  - `needs_you`: the caller's session with the oldest open ask;
  - `waiting_on`: another person's session with the oldest open ask;
  - `working`: a running or starting session, using the latest activity.

  `name` is the session owner's name, including for `needs_you`.

## Composition

- The design names two Computer-object calls, `briefs` and `people`. They are one `work.context` op, so a page costs one round trip. It returns `{ sessions, people, callerEmails }`.
- `work.stamp` is the second op. It only reads the counter.
- The email lookups in `briefs.ts` go through indexes: `sessions(lower(owner_email))`, `sessions(owner_user_id)`, `sessions(owner_id)` and `people(lower(git_email))`.
- Briefs carry `status` and `openAskAt`, not the 3.7 attention, aside or unpublished fields.
- `mine` is true when the item owner's email is in `callerEmails`. `callerEmails` holds:
  - the email the edge asserted;
  - the `owner_email` of the caller's sessions;
  - the `people.git_email` linked to the caller's sessions.

  Emails matching "noreply" are dropped.
- Other people's private Slack sessions are left out of `items[].sessions` and out of history. Their `sessionId` is null. A trailer that names a Slack runner key is mapped to the public session id.
- (S7) The edge now asserts `user_name` and `user_email` for dashboard (cookie) callers too, from `users` joined to `org_memberships`. Two effects:
  - sessions created from the dashboard now store the owner's name and email;
  - `me` and the actor name on dashboard writes become the member's name, where they were empty before.

## Scopes

- The new scopes are `work:read` (all GETs) and `work:write` (PUT).
- Both are named-only, like `secrets:write`. Wildcard, legacy and `sandbox:*` keys do not get them. The dashboard gets every scope.
- The edge's `KEY_SCOPES` and `COMPUTER_SESSION_KEY_SCOPES` are unchanged, so keys created by the CLI or a session lack the work scopes until someone decides they should have them.
- A session principal can read but is refused on PUT (`computer_principal`).

## Portability

- `index.ts`, `item.ts`, `github.ts` and `platform.ts` name no platform.
  - They use `platform.ts`: `IndexStore` (exec and transaction), `Clock`, `Scheduler` and `Fetch`.
  - `index-do.ts` is the only file that imports `cloudflare:workers`. It adapts `ctx.storage.sql`, `transactionSync`, the alarm and `waitUntil`.
- The tests run the index on `node:sqlite` (`test/fixtures/work-platform.ts`). That store refuses more than 100 bind parameters, as Durable Object SQL does.
- A boundary test in `work-index.test.ts` fails if any of the four files names `cloudflare:`, `SqlStorage`, `DurableObject`, `ctx.storage`, `Date.now`, `setTimeout` or a bare `fetch(`.

## GitHub

- Every request is aborted after 10 s, body included.
- 429, and a 403 that is a rate limit, pause that resource until its reset.
  - A 403 is a rate limit when it has `retry-after`, `x-ratelimit-remaining: 0`, or a body that says "rate limit", "abuse" or "secondary".
  - The pause is at least 60 s.
  - There are two resources, `core` (REST) and `graphql`, each with its own pause. A GraphQL limit stops only the pull request refresh.
- Only "Resource not accessible by integration" (`access_denied`) and a 404 (`repository_not_found` / `branch_not_found`) are permanent. Any other 403 or 5xx is transient: no problem is stored, and the next look tries again.
- A stored problem heals itself. The alarm retries it after 1 minute, doubling to 1 hour, and clears it on the first success.
- Renamed repositories:
  - A redirect means the repository was renamed. The index reads `/repos/{owner}/{name}` and stores the new owner and name.
  - A 404 on the stored name is retried once by the stored repository id (`/repositories/{id}`) before it becomes `repository_not_found`.
- `spare()` (a fifth of the quota left) gates the build, the advance, the open fill, the walk and closed reads.
- (S10) The pull request token is narrowed to the linked repositories under the installation's account, lowercased and sorted. A link to another account's repository is never asked and shows as unreadable.

## Index (3.2, 3.6)

Tables:
- `items`, with `stage` as a column and indexed;
- `files`: when two files claim the same number, the open file wins, then the lowest path;
- `links`;
- `commits`: what a listing or a detail read gave, and for which folder it was listed;
- `revisions`: one per item per commit;
- `pulls`;
- `meta`.

A schema version change drops the derived tables and keeps the setting.

### The first build
1. The ref, the root tree, and the `work/` and `done/` trees.
2. A row for each file. Open bodies are read in batches of 50, continued by the alarm. Closed bodies are read on first view.
3. No commit calls. Dates and authors are null.

The walk fills them, with one `commits?path=work` and one `commits?path=done` listing paged back from the head, then the details of each listed commit.

### An advance (head moved from cursor C to H)
1. `compare/C...H` (one page; commits are not paged).
   - A status other than `ahead` or `identical`, meaning C is not an ancestor of H, starts a rebuild. Links of the items that remain are kept.
2. The changed item files:
   - from compare's file list when it has fewer than 300 entries;
   - otherwise compare's list may be cut, so the root tree at H is read, and only the folder trees whose sha moved since the last build or advance. Unchanged folders cost nothing, whatever the size of the range.
3. Blobs are read only for changed items: open ones always, closed ones when there are 50 or fewer.
4. One transaction writes the rows. A changed item's `updatedAt` becomes null, and a stage move nulls `closedAt` and `closedBy`, until the walk dates them.
5. A one-commit range takes its dates, authors and trailers from compare itself. A longer range queues a listing of each touched folder at H, and the advance runs one page of each plus at most 10 commit details. The alarm continues the rest: 2 pages and 10 details per tick, while `spare()`.
6. A listing stops at the first commit already listed for that folder, or at a short page.
7. Each detailed commit is applied in its own transaction:
   - revisions and links;
   - `updatedAt` is the latest commit;
   - `createdAt` and the author come from the add, or from a rename from a non-item path;
   - `closedAt` and `closedBy` come from the latest move into `done/`.

   Order does not matter, so the walk may meet commits in any order.
8. A commit's files come from `commits/{sha}` at 300 per page, up to 10 pages.

### History
- History is served from `revisions`.
  - Once the walk is done it costs no GitHub call.
  - It follows renames and the move to `done/`, because each revision is filed under the item number.
- Before the walk is done, the item's known paths are each asked `commits?path=…&sha=head` for the missing commits, within 5 s, and merged by `(at, sha)`.

### Pull requests
- At most one GraphQL query of 50 every 5 minutes while the board is read.
- Order: links never asked first, then the oldest `checked_at`.
- `merged` and `closed` are final and never asked again. `unreadable` is asked again after a day.

### Reads
- Reads never wait on the index's write chain.
- A read whose head check is older than 10 s starts a look in the background and answers from what is stored.

## Call budgets (GitHub requests)

Measured with the fake GitHub in `work-index.test.ts`. The fake enforces the real limits: compare at 300 files, `per_page` at most 100, commit files at 300 per page, content-addressed trees.

| Operation | Calls |
| --- | --- |
| PUT repository | 2: the repository and the branch ref. |
| GET repositories | 1 page of 100 per installation, up to 5 (500 repositories), plus a token when none is cached. |
| First build, 150 open + 500 closed | 154: 1 ref + 3 trees + 150 blobs. No commit calls. |
| Walk after that build | 5: 2 folder listings, then 3 pages of the import commit's 650 files. |
| Advance over 500 commits (400 non-item files, 100 item edits) | 115: 1 ref + 1 compare + 2 trees (root, `work/`) + 100 blobs + 1 listing page + 10 details. No rebuild. |
| The walk finishing that range | 91, over later alarms. |
| Advance over one commit | 3: ref + compare + one blob per changed item. |
| Board poll, unchanged | At most 1 ref per 10 s window, plus the two stamp calls (no GitHub). A 304. |
| Item page | 0, or 1 blob the first time a closed item is opened. |
| History once walked | 0. |

## Limitations

- The walk stops a folder's listing at the first commit it has already listed. Commits that a merge brings in and that are older than an already-listed commit can be missed. The knowledge repository is mostly linear, and a rebuild re-lists everything.
- Before the walk is done, history asks GitHub by the paths the index knows. A name an item had before a rename it has not walked yet is not known.
- (S8) The duplicate-number warning already names the hidden files. Unchanged.

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
- Whether GitHub's 403 bodies for secondary limits always contain the words matched above, and whether `response.redirected` is set for a renamed repository through a Worker's fetch. Both follow GitHub's docs, and the 404 path by id covers the second if not.
