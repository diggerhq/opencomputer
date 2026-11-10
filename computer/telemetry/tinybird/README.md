# Calvin telemetry: Tinybird project

One datasource of facts, pipes that derive turns from it, and fifteen endpoints
(work 054, "Tinybird project").
Built and tested in CI against Tinybird Local, and deployed with
`tb --cloud deploy` (`TB_TOKEN`, `TB_HOST`).

| datasource | one row per | sort key | retention | dedup |
|---|---|---|---|---|
| `calvin_events` | event (the shared envelope; `data` is a JSON string) | `session_key, occurred_at, event_id` | 90 days | `LIMIT 1 BY event_id` |
| `calvin_turns` | legacy: the wide row runners wrote before calvin#49; read only through `turns` | `sent_at, org_id, path` | 400 days | `LIMIT 1 BY turn_id` |

Processes report facts, never derived numbers: what happened, when, and which
turn and trace it belongs to. Every interval, offset and KPI input is SQL here,
so a formula is fixed in one place and applies to history.

| pipe | one row per | derived from |
|---|---|---|
| `turns` | turn: every offset from `sent_at`, TTFT, K3 overhead, longest silence and its cause, tool input vs run time, thinking time, first content (`first_content_ms`: the first write that was not the turn's opening `Started` card, tagged `placeholder` on its `surface.call`; K3 uses it, K2 stays on `first_visible_ms`), the context at the first request (`ctx_tokens`), first-token waits after tool results (`inter_call_ttft_ms` sum, `inter_call_ttft_max_ms`), usage, cost | runner facts by `turn_id`, gateway and host events by `trace_id`; legacy `calvin_turns` rows for turns without facts |
| `steers` | steer: K6 latency, sent → pushed into the running turn | `prompt.pushed` (legacy `steer.delivered`) |
| `visuals` | visual episode (work 063): first render (Bash `command_kinds` browser/media, or the call a visual was posted from) since the turn's previous visual → the next `file.posted` image or video, or `abandoned`; renders and installs in it | `model.block_started`, `tool.completed`, `file.posted` |

Query them like tables (`SELECT … FROM turns WHERE sent_at > …`). Their SQL is
tested over real runner facts in a local ClickHouse
(`scripts/turns-test.py`; `visuals` by `scripts/visuals-test.py`, fixture from `src/dev/telemetry-check.ts --out`);
`scripts/turns_local.py` runs any query over an NDJSON export the same way.

| endpoint | parameters | answers |
|---|---|---|
| `trace` | `trace_id` | one message's waterfall: events with `start_ms`/`end_ms` from `sent_at`, then the turn row (`name = 'turn'`, offsets in `detail`) |
| `session_timeline` | `session_key`, `since?`, `until?` | every event and turn of a thread |
| `kpi_summary` | `since`, `until`, `path?`, `harness?`, `org_id?`, `include_synthetic?` | K1 to K8 per path: p50/p95/p99 and sample counts |
| `compare` | `since`, `until`, `by` (harness, provider, model, surface, substrate, path, or `ctx`: `ctx_tokens` in 0-100k / 100-150k / 150-200k / 200-300k / 300k+ buckets), `include_synthetic?` | K2 to K5, cache hit ratio, tokens, cost and failure ratio by that dimension |
| `slack_by_protocol` | `since`, `until`, `org_id?`, `include_synthetic?` | 084 Q1: Slack K1 to K6 per runner protocol (`v3`, `v4`, `v4+client`) and path, with the journal's cost per v4 turn |
| `session_log_cost` | `since`, `until`, `by?` (`org_id`, `session_key`, `surface`), `org_id?` | 084 Q2: journal batches, SessionLog appends, latency, rows, bytes, dupes, refusals, spills |
| `freshness` | `since`, `until`, `org_id?`, `per_turn?`, `include_synthetic?` | 084 Q3: event age at each hop, host → DO → API → wire → opc |
| `http_api` | `since`, `until`, `org_id?`, `by_key?`, `include_synthetic?` | 084 Q4: edge and blue requests by route, method, status: latency, DO and log time, 503s, 429s, long-polls; outages |
| `wire` | `since`, `until`, `org_id?`, `include_synthetic?` | 084 Q5: wire Worker, tickets, connects, refusals, closes, attaches, flush backpressure, samples |
| `recovery` | `since`, `until`, `org_id?` | 084 Q6: gaps, stale epochs, recover alarms, held and replayed writes, adoptions, resends |
| `cli_experience` | `since`, `until`, `org_id?`, `client_version?`, `os?` | 084 Q7: opc's own timings (first output, attach, reconnect, controls, render lag, errors) |
| `interactive_latency` | `since`, `until`, `org_id?`, `include_synthetic?` | 084 Q8: API writes at runner, blue and opc, with Slack K6 for comparison |
| `keys` | `since`, `until`, `org_id?` | 084 Q9: key syncs, revokes, requests still arriving with a revoked key |
| `computer_load` | `since`, `until`, `bucket?` (minutes, 5), `org_id?`, `host_id?` | 084 Q10: peak host, journal, mirror and wire gauges per host and bucket |
| `optimize_checks` | `since`, `until`, `t_<id>?`, `n_<id>?`, `include_synthetic?` | 084 "do we need to optimize?": the four decision checks, value vs threshold and a verdict; defaults from `thresholds.json` `computer_api` |

Time windows are `since`/`until` (`YYYY-MM-DD hh:mm:ss`, UTC); `from` is a
reserved word in Tinybird templates. Synthetic (canary) traffic is excluded
unless asked for.

## Tokens

None are committed. The two append tokens and `calvin_read` are declared in
the datafiles and created by `tb deploy`; copy them from the workspace UI.

Give each consumer its own token with the narrowest scope, and store it in
that consumer's secret store, never in this repository:

| token | scope | give it to |
|---|---|---|
| `calvin_append_gateway` | append `calvin_events`, `calvin_turns` | the gateway, as its secret `TINYBIRD_APPEND_TOKEN` |
| `calvin_append_collector` | append `calvin_events`, `calvin_turns` | the collector Worker, as its secret `TINYBIRD_APPEND_TOKEN` |
| `calvin_read` | read both datasources and the endpoints | whoever queries the endpoints, as `TINYBIRD_READ_TOKEN` |
| `<Grafana token>` | `WORKSPACE:READ_ALL` (create by hand) | Grafana's ClickHouse data source, as its password |
| `<deploy token>` | workspace admin | CI, as the secret `TINYBIRD_TOKEN` |

## Fixtures and tests

`fixtures/*.ndjson` are generated by `python3 telemetry/scripts/tinybird-fixtures.py`:
a `new` and a `warm` trace in one thread, a twice-delivered event and turn, a
silent turn, a steer, an abandoned turn and a synthetic canary turn, all dated
2030 so the TTLs never expire them. `tests/*.yaml` hold each endpoint's
expected output; the KPI values in them were computed by hand (linear
interpolation between samples) and then checked by running the SQL.

```bash
tb local start && tb --local build && tb --local test run
```

The work 084 endpoints have no `tests/*.yaml` yet. They are tested in a local
ClickHouse by `scripts/computer-api-test.py` (needs `chdb`), over the runner
fixture copied as a v3 and a v4 session plus hand-made 084 events, with every
value computed by hand; it also runs every panel and rule query of
`../grafana` and checks that `optimize_checks` defaults match `thresholds.json`:

```bash
python3 telemetry/tinybird/scripts/computer-api-test.py
```
