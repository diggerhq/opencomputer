# Calvin telemetry: Grafana

Seven dashboards and the alert rules
(work 054, "Dashboards and alerts"),
generated from `dashboards.mjs`, `rules.mjs`, `sql.mjs` and
`../thresholds.json`. Never edit the JSON by hand:

```bash
node telemetry/grafana/render.mjs           # regenerate after changing thresholds or queries
node telemetry/grafana/render.mjs --check   # CI: fails when stale or a threshold exceeds its budget
```

## Setup (Grafana Cloud)

1. Install the ClickHouse data source plugin (`grafana-clickhouse-datasource`) and, for the trace gantt, `marcusolsson-gantt-panel`.
2. Add a ClickHouse data source whose UID is the value of `DATASOURCE_UID` in `rules.mjs` (the rules refer to it by UID): server `clickhouse.<region>.tinybird.co`, port 443, protocol HTTP, secure; user and password as in [Tinybird's Grafana guide](https://www.tinybird.co/docs/forward/guides/connect-grafana), with the read-only Grafana token (see `../tinybird/README.md`, "Tokens") as the password.
3. Import `dashboards/*.json` (Dashboards → Import); choose that data source for `$datasource`.
4. Provision `alerting/rules.json` (file provisioning, or `POST /api/v1/provisioning/alert-rules` per rule) into a folder named `Calvin`.
5. Contact points: a Slack channel of your choice (`#<alerts-channel>`) for every rule with `team=calvin`, and email in addition for rules labelled `email=true` (the absence rules: canary, host silent, gateway down, pipeline silent), since Slack is also the product's frontend.

## Computer API (work 084)

`computer-api.mjs` builds `dashboards/computer-api.json` (uid
`calvin-computer-api`), the Slack-by-protocol panels at the end of Speed, and
the `calvin-computer-api` rule group, from the `computer_api` rows of
`../thresholds.json`. Its top row, **Do we need to optimize?**, has one panel
per candidate (Computer DO contention, SessionLog append/commit, Slack K2/K3
v4 ÷ v3, runner journaling on the hot path), each with its threshold line and
the reasoning in its description; the `optimize_checks` endpoint returns the
same checks with a verdict. Rows `kind: decision` are those checks; rows
`kind: alert` each need a rule (`render.mjs` fails otherwise).

The Computer DO's CPU time is not in Tinybird: blue's `do_*` timings measure
awaits, since a Worker's clock does not advance during synchronous code. Check
it in Cloudflare's GraphQL analytics (the query is in the 084 instrumentation
answers); no panel reads Cloudflare.

## Rules

KPI rules come from `thresholds.json` (one per KPI and path); each returns 0
below its minimum sample count. Fixed rules: K7 failure ratio, any
`queue.failed`/`turn.abandoned`, dispatches parked without a host, K8 rate
limiting and error ratio, canary missing or failing, telemetry drops, batch
gaps, dispatches with no runner events, host silent, gateway down, pipeline
silent, and deploy regression by `runner_version` and `gateway_version`.
Absence rules treat no data as firing. Group `calvin-computer-api`: event
freshness p95, API 503 ratio, journal gaps, recover alarms, held-write
timeouts, wire refusals, and Slack K2/K3 on v4 runners vs v3.

K8 has no latency threshold: runners emit `surface.call` only for slow,
failed or rate-limited calls, so a p95 over those events is not the call
latency.
