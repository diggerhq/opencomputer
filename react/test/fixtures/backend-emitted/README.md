# Backend-emitted event logs

Session logs the platform's own tests recorded from a real host turn go here,
one JSON file per recorded session or turn, in the shape
`GET /sessions/<id>/events` returns. Every `*.json` file in this directory is
run by `react/src/fixtures.test.ts` on `npm test`: replayed whole and in
pages, and checked for a terminal status on every turn, tool rows settled
with their turn, unique tool rows, and the result tool's committed output as
a decoded value equal to the turn's result.

The file shape is the one the authored fixtures in `../documented/` use:

```json
{ "events": [ ...events, in log order... ], "turns": [ ...expected turns, optional... ] }
```

`turns` is optional; when present it is compared for deep equality with what
the reducer produces. Without it the invariants above are still checked.
Other top-level fields (`description`, `recordedBy`, `runtime`) are the
recording's own notes and are not read.

Recordings are copied from the platform's test fixtures, never authored or
edited here; the recording test names the volatile values it normalizes
(ids, timestamps, durations).

| File | Recorded by | What it holds |
| --- | --- | --- |
| `workerd-turn-with-result.json` | the platform's Workerd session test, "public tool events" | One turn: a failed ordinary tool call, then the result tool started, reporting progress and completed by its commit with `result: true` and the decoded value |
