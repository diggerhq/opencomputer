# Calvin (package name still `slack-presence`)

Claude Code (Agent SDK) driven live from Slack. Start with README.md; it has
the terminal→Slack mapping, setup, deployment shapes and file layout.

- `npm run check` before every push: `tsc`, `biome lint`, `vitest run`, the
  file-size ratchet. CI runs the same on every PR, and `main` deploys only
  after it passes.
- Fast loop without Slack: `npx tsx src/dev/fake-run.ts "<prompt>" ["<steer>"]`
  (real Claude, fake Slack client that prints every API call). The other
  `src/dev/*-check.ts` are integration checks, run by hand (README "Development").
- Secrets live in gitignored `.env`; never commit it, `state.json`, or `workspaces/`.
- Design notes live outside this repository; comments cite them as "work NNN".
  The code-structure plan is work 050.

## Code conventions

These exist to keep the repository splittable as it grows; the file-size
ratchet (`scripts/max-lines.mjs`) enforces the first one mechanically.

1. **One concept per file**, and a header comment that says what the file owns
   and its invariants (`runner/segment.ts`, `runner/agents.ts`, `ipc.ts` are the
   template). A file over 400 lines is a signal to split by concept, over 600
   fails `check`. Never raise the limit; shrink the file.
2. **Unit tests sit next to the code** as `<file>.test.ts`, and test the pure
   parts (rendering state, parsing, routing against fakes). Every bug fix adds
   a unit test where one can express it, otherwise extends a dev check.
3. **`src/protocol.ts` is the only thing two processes share at runtime.**
   Changing it means: keep old `t` values readable, bump `PROTOCOL_VERSION`
   when a field's meaning changes, and keep the backend's gateway side
   (its copy of the protocol in managed-agents) in step.
4. **`any` only at the edge.** Untyped SDK events and Slack payloads are cast
   once where they enter; the rest of the code works on named types. Biome
   warns on every `any`; the count must not grow.
5. **Environment variables are read where a process starts** (`main.ts` of
   gateway, host, runner) and passed down, not read ad hoc in modules. New
   variables are documented in the README tables.
6. **Slack calls go through one place per process** (today `Session` and
   `Segment`; a `SlackThread` helper is 050 phase 2), so a fake client covers
   everything and `thread_ts` handling is written once.
7. **No behaviour change in a refactor PR.** Move code, add tests, then change
   behaviour in a separate PR, so each is reviewable on its own.
