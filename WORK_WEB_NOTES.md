# Work board and item page (web): choices made

Build step 3, web side. The code follows tech design 3.10 and 3.11. Where the
contract left something open, the simplest reading was taken, and it is
written down here.

## API shapes assumed

The calls go to the `/api` base with the dashboard cookie, like the session
routes: `/api/managed-agents/computer/work/...`. The schemas are in
`web/src/managed-agents/work/api.ts`. Every object is loose, so the server can
add fields without breaking the screens.

- `GET /work/repository` returns `{repository: Repository | null}`.
- `PUT /work/repository`:
  - Body: `{installationId, owner, name, branch}`.
  - Returns `{repository}`.
  - Sends an `Idempotency-Key` header.
  - `installationId` is the installation `id` string that `GET /managed-agents/computer` lists under `github.installations`.
  - `owner` is that installation's `accountLogin`.
  - The repository `name` is typed by hand, because no endpoint lists the repositories a computer installation can reach.
- `Repository` is `{installationId: string|number, owner, name, branch, problem?: string|null}`. A non-empty `problem` means the repository cannot be read; the board then shows it and links to settings.
- `GET /work/items?stage=open` returns `{repository, head, asOf, building, items}`.
  - It is polled every 15 seconds with `If-None-Match: <last ETag>`.
  - A 304 keeps the cached page. `apiFetchResponse` now passes a 304 back to the caller instead of throwing; this is the one change to the shared client.
  - When `repository` is null, the board shows the "what is an item" empty state and the repository form.
- `GET /work/items?stage=closed&limit=50[&cursor=]` returns `{items, nextCursor}`.
  - It is fetched once the repository is set, with "Load more" following `nextCursor`.
- `GET /work/items/{n}` returns `{item, body}`. It is polled every 15 seconds.
- `GET /work/items/{n}/history[?cursor=]` returns `{revisions, nextCursor}`. It is fetched only while the History tab is open.
- `Item` and `Revision` follow the contract field for field. Item sessions are `{id, title, ownerName}`, plus an optional `status`; see "Beyond the contract".
- Any 404 from a `/work` route reads as "not available yet" (section 4).

## Beyond the contract, or left out

- Session state:
  - The spec asks for "sessions with state", but `Item.sessions[]` has no state in 3.10.
  - The web accepts an optional `status` (a session status string) and shows a status dot and the word when it is there. Without it, only the title and owner show.
  - The service should add `status`, or the spec should drop the request.
- Related items are not in the contract, so they are not shown.
- Close and Reopen are left for step 5. The places for them are marked with comments:
  - The Ready to close card's action slot (`Card` children).
  - The closed card.
  - The item header next to "View on GitHub".
- "New session on this item" is left out, because the dashboard has no link pattern that opens a session with a prefilled prompt. `computer/sessions` reads no prompt parameter.
- The reason a closed item was closed is not in the contract. Closed cards show "Closed by X" when `closedBy` is set, and otherwise "Closed".

## Presentation choices (no derived state)

The web renders the server's `stage`, `readyToClose`, `attention`, `mine`, `warnings` and `unpublished`. The client only filters, orders and words them.

- Columns:
  - In progress is `stage=open` with `!readyToClose`.
  - Ready to close is `stage=open` with `readyToClose`.
  - Closed is `stage=closed`.
  - Within a column, items with `attention.state = needs_you` come first, then `updatedAt` newest first.
- Attention: only `needs_you` is coloured (amber). Waiting reads "waiting on X · 3h" and working reads "agent working"; both are grey.
- Stale: an open card whose `updatedAt` is 14 or more days old is shaded, and "no change in N days" replaces its time. The threshold is a client constant.
- Closed column: by default it shows items with `closedAt` in the last 7 days. "Show older" (kept in the address as `?older=1`) shows every fetched closed item.
- Address state: the tab (`?tab=everyone`; Mine is the default), the text filter (`?q=`) and the tag filter (`?tag=`) all live in the address. Tags on cards set the tag filter.
- Mine empty: shown when Mine has nothing, Everyone has something and no filter is set. It links to Everyone.
- Index age: shown as "As of Nm ago" when `asOf` is more than 5 minutes old. While `building` it reads "Reading owner/name…". `problem` appears in red with a Settings link.
- Item page:
  - The frontmatter and a leading `# Title` are removed from `body` before rendering, because the header already shows the title and the aside shows the fields.
  - Relative links in the doc resolve against `item.url` on GitHub. `AgentMarkdown` gained an optional `resolveUrl` prop for this.
- The item page tab is kept in the address (`?tab=history`).
- Pull request dot colours use the status tokens:
  - open: running (green)
  - draft: stopped (grey)
  - merged: hibernated (blue)
  - closed: error
  - unknown: outline
- Where things live:
  - The repository setting is on the Computer page (`/computer#work-repository`), after "Your agent", and is also embedded in the board's no-repository state.
  - The rail gains one link, "Board" (`/computer/work`). It is shown unconditionally like Secrets; the page itself redirects when the organization has no computer.

## Preview mock

`web/src/api/mock-work.ts` holds invented data. Pick a scenario with `?work=none|empty|mine-empty|building|problem|missing`.

## Visual pass

A second pass on arrangement and type only; what the screens show and do is
unchanged. It stays in the dashboard's family: Inter, `text-sm` (14/20) for
names and `text-xs` (12/16 or 12/20) for everything quiet, the warm neutral
tokens, 1px `border` lines, `rounded-lg` panels. The benchmark is the calm and
regularity of Linear's board and issue page, not its features.

- Grid: three equal stage lanes on one grid (`lg:grid-cols-3`), one stack of
  cards each. Each lane is a tinted region (`bg-muted/60`, darker than the
  shell in the dark theme) that runs the full height of the board, with its
  header inside it, so the three stages read as three regions at a glance.
  Lanes are 16px apart; cards inside a lane are 8px apart. Below `lg` the
  lanes stack.
- Lane header: stage name (`text-sm` medium) and count (muted, tabular) on the
  left; the note on the right (`text-xs` muted). The "N need you" note is the
  one place the header uses the amber accent.
- Card anatomy, fixed order, three tiers:
  1. Identity line (`text-xs`, muted, 20px): number, at most two tags and
     "+n", then on the right the doc-problem and unpublished icons and the
     owner's avatar.
  2. Title (`text-sm` medium, 20px lines, at most two lines), then the state
     line (`text-xs` muted, 20px lines, at most two lines; left out when the
     doc has none).
  3. Activity line (`text-xs`, muted, 20px): the attention marker on the
     left (or "Closed by X" on a closed card); on the right a pull-request
     icon with one dot per pull request (state on hover), the session count
     with an icon, and the age, right-aligned and tabular.
- Spacing: 12px card padding; 8px between tiers, 4px between title and state.
  The activity line sits 12px below the text above it.
  Every line box is 20px, so cards differ in height only by whole lines.
- Tags: sans, 11px, hairline border, no fill, instead of filled monospace
  pills. Two at most on a card; the rest are counted and listed on hover.
- Colour: only "needs you" is coloured (amber). Doc problems and unpublished
  changes are grey icons on the card (words and colour on the item page).
  Pull request dots keep their state colours, as the spec asks for state.
- Stale: the card loses its raised surface and sits flat on the lane with a
  dashed border, its title dimmed; the age says "no change in N days".
- Item page: a neutral stage pill, then one metadata line with dot
  separators (a dot that wraps to the start of a line is clipped away). Only
  "needs you" and the doc problem keep their colour there; "unpublished
  changes" is grey with words. The doc is held to 42rem with 32px before each
  section heading; task lists have drawn boxes instead of bullets, and done
  items are muted. The aside is 20rem, set off by a rule, and sticky. In
  Details, session and pull request dots sit in a 20px column that lines up
  with the People avatars. History is a timeline: a hollow dot on the
  summary's first line, the age on the right of that line, then a single
  non-wrapping meta line (author · session · commit) where only the author
  truncates.
