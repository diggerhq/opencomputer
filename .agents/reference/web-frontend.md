# Web dashboard — engineering principles

What we believe keeps this dashboard correct and maintainable, and why we hold
each one. Frameworks and versions will change; these shouldn't. This is about how
the frontend is engineered, not how it looks — specific visual choices live in
the tokens and components. Each principle names where it lives today so it's
findable, not so it's pinned to a library. The dashboard is a React SPA served at
the edge (`dev-edge-setup.md`). Reference, not runbook.

## Own as little as possible, and make every change earn its place

The best code is the code you don't maintain. Prefer a well-chosen library over a
bespoke version of the same thing, and periodically ask the inverse: what are we
hand-rolling that a standard tool does better and would let us delete? Adding a
capability you need is the point of a change; bumping a version for freshness is
not — a dependency change has to buy something. Do the smallest thing that's
correct: skip the abstraction, the gallery, the config you don't need yet. And
sequence the work — get the foundations right (a real styling system, shared
components, forms, a linter) before the nice-to-haves, because polish on a weak
foundation is rework.

## Keep the code honest: one current path

There is one live behavior, not a runtime fork between an old and a new one. No
version flags, no "if enabled" branches the running code chooses between — they
are a tax on every future change and the source of "which path am I even on"
bugs. Simplify toward a single linear path while the product is young enough to
afford it. Unused code may sit dead and removed features move to a clearly
dormant module, but neither should masquerade as a live alternative. The code in
front of you should describe what actually ships.

## Keep one source of truth for every shape and value

A fact lives in one place and everything else derives from it. Data shapes are
defined once and the types are inferred from that definition, so a type cannot
drift from the validator that enforces it (today: schemas in
`src/api/schemas.ts`). Visual values — color, spacing, scale, radii — come from
one set of tokens, not numbers typed at each call site, and elements align to a
shared grid rather than by eye. The cost of not doing this is concrete and we
paid it repeatedly: a color left over from a previous theme that nobody could
trace, a focus ring heavier in one place than another, a header and a row
"nearly the same size but not quite." When a value has one source you change it
once; when you can't tell where a value comes from, that is itself the bug.

## Validate data where it enters the app

Every response is parsed against its schema at the boundary, in one place
(`apiFetch`). A mismatch throws in development — including against the local mock,
which is what keeps the mock honest — and degrades in production rather than
taking a screen down, so a backend that's briefly ahead of the schema costs a log
line, not an outage. Data is untyped (`unknown`) until it has been validated;
nothing assumed-shaped flows inward. The boundary is the one place the backend's
reality meets the UI's assumptions, and checking it there means a failure points
at its cause instead of surfacing as a crash three components away.

## Don't let layout or behavior depend on transient state

Two instances of a component that differ only by their data should still align
and behave the same. Reserve space for a control only some rows have, so a table
doesn't change height row to row. Render a conditional panel once its data is
known, never show it mid-load and then take it away. Confirm an async action only
once it has actually succeeded — the clipboard says "Copied" after the write
resolves. Key lists by stable identity, never array index, or append and filter
reconcile onto the wrong rows. Clean up everything you start (timers, sockets,
subscriptions) and guard callbacks against firing after teardown. This is the
class of bug the happy path never reveals: jitter, flashes, leaks, false
confirmations.

## Give state one owner, and reset it deliberately when context changes

Server state lives in the query cache, transient UI state lives in the component,
and the two don't shadow each other. When the context changes — switching org —
reset both on purpose: clearing the cache does not refetch an already-mounted
query, and it does not touch a component's own drafts or filters, so the refetch
and the remount are made explicit. State that quietly survives a context switch
is the whole class of "it's still showing the previous account" bugs.

## Contain failures, and surface them once in human terms

A render error is caught at the route boundary, and at the top, so one screen
failing is not a blank app. Errors reach the user through a single path: a
readable message in the UI, the raw error in the console for whoever debugs it. A
dashboard renders live systems; something will eventually be missing or null, and
the only question is whether it costs a panel or the page.

## Let the type system and the linter carry load

Type-checking and type-aware linting are on, and findings are fixed at the cause
rather than silenced. Turning them on is what surfaced unhandled promises,
untyped data at fetch boundaries, and a navigation call whose return type had
quietly changed — a class of bug that costs nothing to catch if you let the tools
catch it. A suppression comment is a promise to owe that bug later; write one only
when you can say why.

## Fast by default, never load-bearing on the optimization

Split code by route and load the heaviest dependencies only when the screen that
needs them opens. Prefetch the likely-next code and data on intent, so a
navigation feels instant. But a prefetch is only ever an optimization: the
destination must behave identically if it never ran. The moment correctness
depends on the optimization having happened, it's a bug waiting for a slow
network.

## Separate mechanical change from behavioral change

A reskin is not a refactor and a refactor is not a feature. Bundling them hides
both: a diff that should be pure mechanics now also moves behavior, and the risky
change disappears inside the boring one. Sequence the work and keep each kind in
its own commit, so each can be read, reviewed, and reverted on its own.

## Verify against reality, and shift uncertainty left

Check a plan against the actual code before building it and write down what you
find; a wrong assumption is far cheaper to fix before it's been built on. Look at
the result instead of trusting it — run it, screenshot it, read the output.
Invite review, address findings worst-first, and fix the cause rather than the
symptom. Not everything suggested is worth doing now: say so and move it to an
explicit "later" rather than doing it reflexively or leaving it unsaid.
