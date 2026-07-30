# OpenComputer sandbox TTI benchmark

Standalone replica of the public [ComputeSDK sandbox TTI benchmark](https://github.com/computesdk/benchmarks)
(runs Fridays 00:00 UTC). Measures **Time-to-Interactive**: wall-clock from
`sandbox.create()` through the first `runCommand('node -v')` succeeding (destroy
excluded), using the **same `@computesdk/opencomputer` adapter the leaderboard uses**
— so these numbers preview what we'll post on Friday.

## Run

```bash
npm install
OPENCOMPUTER_API_KEY=osb_xxx node bench.mjs               # all 3 modes, PROD, 100 iters
OPENCOMPUTER_API_KEY=osb_xxx node bench.mjs --mode sequential --iterations 20
```

Defaults to **prod** (`https://app.opencomputer.dev`). Point elsewhere with
`OPENCOMPUTER_API_URL` (e.g. dev `https://app2.opensandbox.ai`).

## Config (env var, `--flag` overrides)

| var | flag | default | notes |
|---|---|---|---|
| `OPENCOMPUTER_API_URL` | `--api-url` | `https://app.opencomputer.dev` | prod |
| `OPENCOMPUTER_API_KEY` | `--api-key` | — | **required**; needs concurrency ≥ `CONCURRENCY` for staggered/burst |
| `MODE` | `--mode` | `all` | `sequential` \| `staggered` \| `burst` \| `all` |
| `ITERATIONS` | `--iterations` | `100` | |
| `CONCURRENCY` | `--concurrency` | `100` | staggered/burst; sequential is always 1 |
| `STAGGER_DELAY_MS` | `--stagger-delay-ms` | `200` | staggered only |
| `JSON_OUT` | `--json` | — | also write raw results to a JSON file |

## Modes (identical to the leaderboard)

- **sequential** — one at a time (concurrency 1) — isolated cold-start.
- **staggered** — ramp, 200ms between starts (concurrency 100).
- **burst** — all at once (concurrency 100) — peak-demand.

## Scoring (ported verbatim)

Stats trim bottom+top 5% of successful runs, then `median / P95 / P99`.
`score = (0.60·median + 0.25·P95 + 0.15·P99) × success-rate`, each metric scored
`100 × (1 − v/10000ms)` (≥10s ⇒ 0).
