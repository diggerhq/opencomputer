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
  - The picker sends the chosen installation's `id`, the repository's `owner` and `name`, and its `defaultBranch` as `branch`. There is no branch input.
- `GET /work/repositories` returns `{installations: [{id, accountLogin, accountType, settingsUrl, repositories: [{id, owner, name, private, defaultBranch, pushedAt}], truncated, problem, problemMessage}]}`, repositories already sorted most recently pushed first.
  - The picker (`RepositoryCombobox` in `RepositorySetting.tsx`) is a combobox like GitHub's and Vercel's, replacing the earlier list of Select buttons. The trigger shows the current `owner/name` (with a lock when private). It opens a popover the trigger's width: a search that filters as you type, then a list of at most 260px, with one row per repository showing a check on the current one, a lock when private and the pushed time. Arrow keys and Enter choose. There is no cmdk in the web, so the listbox is built by hand with aria roles. The popover is `ui/popover.tsx`, a thin wrapper over the `radix-ui` package already installed, so there is no new dependency.
  - With more than one installation the rows are grouped by account, and each group header has its own "Adjust access" link. With one, the footer reads "Missing a repository? Adjust GitHub App access" plus a refresh. Both links open the installation's `settingsUrl` in a new tab.
  - The list is read again whenever the window regains focus (`refetchOnWindowFocus: 'always'`, past the 30 s default `staleTime`), so coming back from GitHub after granting access shows the new repository.
  - Choosing the current repository again does nothing, unless it has a problem: then it saves again, which is how "Choose again" retries a missing branch.
  - When the list loads with no installation, "Connect GitHub" starts the managed GitHub App install in a new window (the same flow as Connections and the Computer page).
  - Choosing a repository when one is already set asks first ("Switch the board to owner/name?"). The wording follows the server's `setRepository`: the index is rebuilt from the new repository's default branch, nothing is written to either repository, and switching back is possible. Whether agents then write new items to the new repository was not checked, so the dialog does not say.
- `Repository` is `{installationId: string|number, owner, name, branch, problem?: string|null, problemMessage?: string|null}`.
  - A non-empty `problem` means the repository cannot be read; the board then says so and links to settings.
  - `problem` is a stable code (`access_denied`, `repository_not_found`, `installation_removed`, `installation_suspended`, `branch_not_found`, `github_app_not_configured`). The code is never shown: the web shows `problemMessage` when present, else its own sentence for a known code (`repositoryProblem` in `board.ts`), else a general one.
- `GET /work/items?stage=open` returns `{repository, head, asOf, building, items}`.
  - It is polled every 15 seconds with `If-None-Match: <last ETag>`.
  - A 304 keeps the cached page. `apiFetchResponse` now passes a 304 back to the caller instead of throwing; this is the one change to the shared client. It returns the `Response`, so the caller reads headers from a 304 as from a 200.
  - The server sends the index's current `asOf` in a `Work-As-Of` header on both 200 and 304. The web reads it on both: on a 200 it overrides the body's `asOf`, on a 304 it replaces only the stored `asOf` and keeps the page (`keepOpenItems`). Without it, a quiet board would freeze `asOf` and say "As of N ago" after 5 minutes.
  - When `repository` is null, the board shows the "what is an item" empty state and the repository form.
- `GET /work/items?stage=closed&limit=50[&cursor=]` returns `{items, nextCursor}`.
  - It is fetched once the repository is set, with "Load more" following `nextCursor`.
- `GET /work/items/{n}` returns `{item, body}`. It is polled every 15 seconds.
- `GET /work/items/{n}/history[?cursor=]` returns `{revisions, nextCursor}`. It is fetched only while the History tab is open.
- `Item` and `Revision` follow the contract field for field.
  - Item sessions are `{id, title, ownerName, status}`; `status` is required, one of `starting | running | waiting | idle | suspended`.
  - `updatedAt` may be null while not known yet. Such an item sorts last within its group, is never stale, and shows no time (card and item header).
  - `closedAt` and `closedBy` may be null on a closed item. The card and header then say just "Closed" with no time (or the `updatedAt` time when only that is known), and the item shows in the Closed column only with "Show older".
- Any 404 from a `/work` route reads as "not available yet" (section 4), except a 404 with code `item_not_found` on the item page: that reads "No item 123", with a link back to the board.

## Beyond the contract, or left out

- Session state: `status` is now in the contract. Details shows the sessions screens' status dot and their word in lower case (working, starting, idle, asleep), with "waiting for an answer" for `waiting`, because the session may be someone else's.
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
  - `KnowledgeRepositorySection` (`KnowledgeRepository.tsx`, props `{id?}`) is the stateful setting and can be mounted anywhere. Its Repository row is the combobox itself (there is no Change or Cancel), with "Open on GitHub" as a trailing icon button. Below it are the branch and its state: "Up to date · read N ago at <short SHA>", "Reading the working docs for the first time…" while building, or the problem sentence in red with a fix per code (Reconnect GitHub for a removed or suspended installation, the installation's `settingsUrl` for a missing repository or denied access, choose again for a missing branch, a note that it is ours for `github_app_not_configured`).
  - It is the second section of the organization Settings page, as `/settings#work-repository`. The Computer page is not the place: it shows the setup wizard until setup is complete. The board's no-repository state embeds `FirstRepository`, the combobox alone.
  - The Settings page was redesigned with it. `components/settings.tsx` holds the shared anatomy: `SettingsSection` (title, one sentence, one panel), `SettingsRow` (three columns on shared edges: a 10rem label, the value, and a trailing action at the panel's right edge; on a phone the label stacks above the value) and `SettingsAction` (the one trailing action style, a quiet ghost button). The sections are Organization, Knowledge repository, Members and Agent environment. The name shows Save and Cancel only once changed, and Escape resets it. Members and invitations have a "…" menu holding Remove or Revoke; your own row has none and is tagged "You".
  - The GitHub repository and commit links are built in the web (`https://github.com/owner/name`, `/commit/<head>`); a `url` on `Repository` from the API would remove that.
  - Queries more than one screen reads (`useOpenItems`, `useRepository`, `useGrantingInstallations`) live in `queries.ts`, so tests that mock `./api` reach them.
  - The board's header names the repository it reads as a quiet link to that setting; when the repository has a problem the link reads "Settings".
  - The rail gains one link, "Board" (`/computer/work`). It is shown unconditionally like Secrets; the page itself redirects when the organization has no computer.

## Preview mock

`web/src/api/mock-work.ts` holds invented data. Pick a scenario with `?work=none|empty|mine-empty|building|problem|missing`.

- The open-items poll goes through `workOpenItemsResponse`, which answers as the server does: an ETag over the page without `asOf`, a 304 while that ETag matches, and `Work-As-Of` on both.
- `problem` sends `access_denied` with a `problemMessage`; `&problem=<code>` sends another code, without a message.
- `/repositories` lists eight repositories under `acme` and two under `acme-labs`, the preview's two installations. `?work=none` shows the combobox alone. The preview's organization (`api/mock.ts`) has four members and two invitations, so the Members section has something to show.
- Item 31 has an unknown `updatedAt`; closed item 8 has no `closedAt` or `closedBy`.
- An unknown item number answers 404 `item_not_found`.

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
