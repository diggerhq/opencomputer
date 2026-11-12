// The telemetry event catalog (work 054, "Seams and the
// event catalog"): every event Calvin may emit, which process emits it, and
// the only `data` keys it may carry. It is data, so `emit` is typed by event
// name and the collector re-validates with the same table.
//
// Invariants: names are `<area>.<transition>` and say what happens, never the
// vendor; `data` values are scalars (string, number, boolean) and never
// content. Adding an event or a key here is the whole schema change: the
// Tinybird column is the JSON `data` string.


export type ServiceName = 'gateway' | 'host' | 'runner' | 'collector';

interface EventSpec {
  service: ServiceName;
  data: readonly string[];
}

const gateway = (...data: string[]) => ({ service: 'gateway', data }) as const satisfies EventSpec;
const host = (...data: string[]) => ({ service: 'host', data }) as const satisfies EventSpec;
const runner = (...data: string[]) => ({ service: 'runner', data }) as const satisfies EventSpec;
const collector = (...data: string[]) => ({ service: 'collector', data }) as const satisfies EventSpec;

export const CATALOG = {
  // ---------------------------------------------------------------- gateway
  'message.received': gateway('surface_event_id', 'redelivery', 'redelivery_reason', 'kind', 'cached', 'cache_layer', 'forwarded'),
  'message.deduped': gateway('dedupe_key'),
  'message.ignored': gateway('reason'),
  'queue.started': gateway('attempt'),
  'queue.retried': gateway('attempt'),
  'queue.failed': gateway('attempt'),
  'command.handled': gateway('command'),
  'ack.done': gateway('indicator', 'call_ms'),
  'links.resolved': gateway('count', 'timed_out', 'forwarded'),
  'dispatch.created': gateway('attempt'),
  'dispatch.sent': gateway('attempt'),
  'dispatch.parked': gateway(),
  'dispatch.resent': gateway('attempt'),
  'dispatch.replied': gateway(),
  // blue#218: accept time, the credit check, the host's credentials and the repository re-read.
  'message.accepted': gateway('ack'),
  'admission.checked': gateway('cached', 'decision'),
  'credentials.resolved': gateway('source'),
  'definition.refreshed': gateway('account_ms', 'github_ms', 'repos', 'changed', 'timed_out'),
  // Model subscriptions held by the computer (work 077 Claude, 082 ChatGPT for Codex); the envelope's
  // `provider` (anthropic|chatgpt) says whose. Never a token, an account id or a fingerprint.
  // `via` slack|dashboard|connect_code; `plan` from the token's claims (chatgpt).
  'subscription.connected': gateway('via', 'verified', 'plan'),
  // `reason` owner|dashboard|member_removed|…; `revoked`: OpenAI confirmed the sign-out (chatgpt).
  'subscription.disconnected': gateway('reason', 'revoked'),
  // One ChatGPT token refresh. `result` ok|retry|rejected|superseded|throttled|none; `failure` the retry's class
  // (http_5xx, http_429, network, timeout, body_timeout, bad_reply, internal); `lost`: the attempt may have reached
  // OpenAI unread, or a rejection followed one; `latency_ms` = duration_ms.
  'subscription.refreshed': gateway('trigger', 'result', 'failure', 'status', 'attempt', 'rotated', 'lost', 'latency_ms'),
  // A revoke at OpenAI (chatgpt): `ok`, or `skipped` when a stored row still holds the token or account.
  'subscription.revoked': gateway('reason', 'ok', 'skipped'),
  // An upstream 401 and what it came to: `verdict` refreshed|stale|unconfirmed|noted|invalidated (noted: the first
  // strike; invalidated: the second, the login stopped).
  'subscription.unauthorized': gateway('verdict', 'refresh_failures'),
  // A ChatGPT login refused at connect, or a Codex thread's seat refused (Claude refusals are not sent); `reason` the
  // parser's or the route's (no_subscription, invalid, limited, …); `at` connect|delivery|push|hello.
  'subscription.refused': gateway('reason', 'at'),
  // The "model" alarm fired with work: limits ended and refreshes due; `late_ms` past the earliest due.
  'subscription.alarm_fired': gateway('limits_ended', 'refreshes_due', 'late_ms'),
  // A delivery whose ChatGPT access token had expired waited for its refresh; `result` the refresh's, or pending.
  'subscription.expired_waited': gateway('wait_ms', 'result'),
  // A connect code (work 082, CLI connect; connect-codes.ts). `action` minted|redeemed|failed|refused; `via`
  // dashboard|slack (minted); `reason` why it was refused (malformed|other_org|unknown|expired), or the connect's
  // error code (failed); `failures` before this redemption (redeemed) or with it (failed); `kept` the code survives.
  'subscription.connect_code': gateway('action', 'via', 'reason', 'failures', 'kept'),
  'host.connected': gateway('host_version'),
  'host.disconnected': gateway('host_version', 'close_code'),
  'interaction.received': gateway('kind'),
  // ---------------------------------------------------------------- host
  'deliver.received': host(),
  'workspace.ensured': host('cloned', 'repos'),
  // `fetch_skipped`: the clone's refs were fresh (workspaces/fetch-schedule.ts), no fetch on the fork's path.
  'fork.repo': host('repo', 'fetch_ms', 'worktree_ms', 'lock_wait_ms', 'fetch_error_type', 'fetch_skipped'),
  'fork.done': host('repos', 'fork_error_type'),
  'runner.launched': host('launch_mode', 'attempt', 'image', 'container.create_ms', 'container.start_ms', 'container.recreated'),
  'runner.ready': host('polls'),
  'deliver.forwarded': host('credentials_sent', 'secrets_count'),
  'runner.exited': host('busy', 'exit_reason', 'last_status'),
  // The warm pool (work 069, host/pool.ts): spare runners, their Claude Code parked before any session.
  'pool.spare_started': host('launch_mode'),
  // `reason`: version (an older release), surplus (the pool was made smaller).
  'pool.spare_evicted': host('reason'),
  // A spare that exited before it was ever ready (its Claude Code did not start).
  'pool.spare_failed': host(),
  // A delivery that could have taken a spare and started cold. `reason`: none, credential, refused, timeout, gone (the spare exited first).
  'pool.spare_missed': host('reason'),
  // Claude subscriptions (work 077): oc-modelproxy's events, relayed by the host from its control socket.
  // A ChatGPT Responses request adds `first_output_ms` (headers written → its first output item; `ttfb_ms` ends at
  // response.created) and the `service_tier` it was served on, both read from its stream (modelproxy/responses.go).
  // Over Codex's WebSocket each response is one (route responses, `transport` websocket, `prewarm` for its warm-up) and the
  // connection one more (route responses_ws, `responses` it carried, `closed`: idle | rebind | drain) (modelproxy/websocket.go).
  'model.request': host('status', 'route', 'stream', 'overhead_us', 'ttfb_ms', 'first_output_ms', 'service_tier', 'fingerprint', 'swapped', 'limit_type',
    'transport', 'prewarm', 'responses', 'closed'),
  'model.held': host('held_ms', 'released'),
  'model.denied': host('reason', 'route', 'bound_provider'),
  'model.proxy_started': host('version', 'bindings'),
  // A unit's credential bound, swapped, released or refused; `mode`, `fingerprint` as the seat's.
  'model.binding': host('action', 'unit', 'mode', 'fingerprint'),
  // Work 082: a session's route was for a provider the connected proxy does not list (a proxy before 082 would have
  // read it as anthropic); the host refused it instead of binding. The `provider` dimension is the route's.
  'model.provider_refused': host('unit'),
  // Work 082: a session's live runner runs another harness than its route (`at: 'route'`) or delivery (`at: 'delivery'`)
  // needs; the host refuses the route to it and restarts the session on `to`. The `harness` dimension is the runner's.
  'model.harness_switch': host('to', 'at'),
  // Upstream pool gauges every minute, counters since the previous one.
  'model.pool': host('open_conns', 'idle_conns', 'active_streams', 'warm_conns', 'idle_pool_miss', 'warm_hits', 'warm_failed', 'dials', 'bindings', 'dropped_messages'),
  // The runner stepped a subscription session's model down after the seat refused it.
  'model.downgraded': runner('from', 'to'),
  // A spare became this session's runner; `duration_ms` is the claim's round trip.
  'runner.claimed': host(),
  'turn.abandoned': host('exit_reason'),
  'token.minted': host('cache_hit', 'repos', 'kind'),
  // `trigger`: 'periodic' (the housekeeping pass) or 'pushed' (a push to the branch forks start from).
  'housekeeping.fetch': host('repo', 'fast_forwarded', 'trigger'),
  'host.sample': host(
    'load1',
    'cpu_pct',
    'mem_used_mb',
    'cpus',
    'mem_total_mb',
    'disk_free_mb',
    'runners',
    'busy_runners',
    'spares',
    'oldest_fetch_age_s',
    'gateway_connected',
    'since_gateway_message_s',
    'telemetry_spooled_bytes',
    'telemetry_dropped',
  ),
  // ---------------------------------------------------------------- host: the computer API (work 084 instrumentation)
  // /tmp/build084/instrumentation-catalog.md (v2) is the contract (blue mirrors it). One event per unit of work, never a
  // rollup: every sum, rate and percentile is a Tinybird query. `*.sample` carries gauges read at that moment only.
  // Per minute on a v4 host: gauges (Q6, Q10).
  'api.sample': host(
    'host_protocol',
    'open_journals',
    'runner_writers',
    'host_writers',
    'journal_bytes',
    'mirror_spooled_bytes',
    'mirror_unacked_max',
    'held_frames',
  ),
  // One per `epoch` frame adopted (or failed): from the frame to the commit (Q6).
  'api.epoch_adopted': host('epoch', 'start_seq', 'tail_events', 'torn', 'held_frames', 'retired_runner', 'attempt'),
  // One per frame held behind an adoption, when it goes; duration_ms is the wait (Q6).
  'api.held': host('asked'),
  // One per session and stale epoch: a runner's frame below the host's epoch, dropped (Q6).
  'api.stale_epoch': host('epoch', 'known'),
  // One per journal batch the mirror sends to the SessionLog DO (Q2, Q3); ages are now - createdAt; held_ms: the wait for
  // the gateway socket to drain, on the first batch after one (084 perf fix 2).
  'mirror.batch': host('events', 'first_seq', 'last_seq', 'oldest_age_ms', 'newest_age_ms', 'resent', 'urgent', 'held_ms'),
  // One per journal-ack covering sent batches: commit_ms from the oldest covered send, age_ms from the newest createdAt (Q3).
  'mirror.ack': host('seq', 'batches', 'events', 'commit_ms', 'age_ms'),
  // The relay's events (api/wire-events.ts), sent over wire.sock as they happen and checked here; surface `cli` (Q3, Q5, Q10).
  'wire.connect': host('connection_id'),
  'wire.refused': host('status'),
  'wire.close': host('connection_id', 'code', 'attaches', 'frames_in', 'bytes_in', 'frames_out', 'bytes_out'),
  'wire.attach': host('connection_id', 'attach_ms', 'via', 'resume', 'replay', 'deltas'),
  'wire.flush': host('connection_id', 'frames', 'bytes', 'events', 'deltas', 'oldest_age_ms', 'wait_ms_max', 'queued_bytes', 'paused', 'merged', 'duplicates', 'telemetry_refused'),
  'wire.detached': host('connection_id', 'reason'),
  'wire.error': host('connection_id', 'method', 'code'),
  'wire.terminal': host('connection_id', 'bytes_in', 'bytes_out', 'exited'),
  'wire.files': host('op', 'bytes'),
  'wire.telemetry': host('connection_id', 'events', 'rejected', 'result'),
  'wire.sample': host('connections', 'members', 'attached', 'terminals', 'queued_bytes_max'),
  // opc's own events (Q7), sent as the wire `telemetry` notification, checked by api/cli-telemetry.ts; surface `cli`.
  'cli.turn': host('client_version', 'os', 'arch', 'first_event_ms', 'first_output_received_ms', 'first_output_ms', 'interrupted'),
  'cli.attach': host('client_version', 'os', 'arch', 'attach_ms', 'connect_ms', 'reconnect', 'gap_ms', 'replayed_events'),
  'cli.control': host('client_version', 'os', 'arch', 'kind', 'round_trip_ms', 'applied_ms', 'ok'),
  'cli.error': host('client_version', 'os', 'arch', 'class', 'close_code'),
  'cli.render': host('client_version', 'os', 'arch', 'lag_ms', 'draw_ms'),
  'cli.connection': host('client_version', 'os', 'arch', 'up_ms', 'frames', 'bytes', 'close_code', 'reconnect'),
  'cli.overflow': host('client_version', 'os', 'arch', 'dropped'),
  // Emitted by every process's emitter; listed once, any service may send it.
  'telemetry.dropped': host('reason', 'count'),
  // ---------------------------------------------------------------- runner
  // Facts only (runner/turn-events.ts); every interval is SQL in telemetry/tinybird `turns`.
  'delivery.received': runner(),
  'prompt.pushed': runner('steer'),
  // host_protocol 4: this runner writes the session's journal (work 084); api_clients: non-mirror API subscribers then (Q1).
  'turn.started': runner('turn_seq', 'host_protocol', 'api', 'api_clients'),
  'names.resolved': runner('count', 'timed_out'),
  'attachments.fetched': runner('count', 'bytes'),
  'intro.posted': runner(),
  // `claimed`: a spare's harness (work 069), up before the session was known; `parked_ms`: how long it waited.
  // `harness_version`, `spawn_ms`, `initialize_ms`, `thread_ms`: a harness that reports its own start-up (Codex's app-server, work 082).
  'harness.started': runner('resume', 'mcp_servers', 'claimed', 'parked_ms', 'harness_version', 'spawn_ms', 'initialize_ms', 'thread_ms'),
  // A JSON-RPC request to the harness failed (Codex's app-server): its `method` and `error_code`, never the message.
  'harness.rpc_failed': runner('method', 'error_code'),
  // Codex's loopback (work 082) refused a peer (`ok` false, `code`: not_loopback, no_socket, no_cgroup, unreadable,
  // not_held), or took over 5 ms to attest one; `pids`/`fds` it read; `duration_ms` the check. Not every check: one per request.
  'harness.peer_check': runner('ok', 'code', 'pids', 'fds'),
  'model.response_started': runner('input_tokens', 'cache_read_tokens', 'cache_creation_tokens'),
  // With the response's usage where the harness reports it only at the end (Codex); Claude's comes with `response_started`.
  'model.response_ended': runner('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'),
  // `kind`: text, thinking or tool; `hidden`: a tool the thread doesn't show.
  'model.block_started': runner('index', 'kind', 'hidden'),
  'model.block_stopped': runner('index'),
  // A "Thinking…" card was shown: renderable output (runner/thinking.ts decides when).
  'thinking.shown': runner(),
  // `command_kinds`: a Bash call's kinds, comma-joined (runner/command-kinds.ts); never the command.
  'tool.completed': runner('is_error', 'command_kinds'),
  // A file in the thread (work 063): `kind` image/video/pdf/text/other, `source` tool/script; `tool_call_id` names the running call when there is one.
  'file.posted': runner('kind', 'bytes', 'source'),
  // prompt-guard.ts withheld a copy of Calvin's prompt: `words` withheld, `where` stream or slack (a Slack call's strings).
  'prompt.withheld': runner('words', 'where'),
  // `queued_ms`: how long the oldest content in the write waited before the call (work 082, `client.lag` = queued_ms + duration_ms);
  // absent on a write that carries no new content (a timer tick, a footer). `placeholder`: only the opening card (work 068).
  'surface.call': runner('method', 'status', 'rate_limited', 'retry_after_s', 'placeholder', 'queued_ms'),
  // The runner's event-loop delay over one window while a turn is open or closing (work 082, `loop.lag`): `max_ms` and `mean_ms` of
  // node's delay histogram, `window_ms` its length. Windows, not ticks: a fact per tick would outweigh the turn it measures.
  'loop.lag': runner('max_ms', 'mean_ms', 'window_ms'),
  // Usage as the harness reports it; `cost_total_usd` is its running total for the process.
  'turn.ended': runner('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'api_ms', 'cost_total_usd'),
  // Session finished the end-of-turn work (final flush, footer, status) and went idle.
  'turn.closed': runner(),
  // Claude Code compacted the conversation (runner/compaction.ts, work 068): `trigger` auto/manual as it reports it;
  // `before_tokens` its count, `after_tokens` the next request's context; `paused_turn` a turn waited on it;
  // `duration_ms` (the envelope's) from the start to the next request, or to the turn's end without one.
  // Fork compaction (runner/harness/claude/shadow.ts): `trigger` shadow, `outcome` swapped/discarded/failed, `reason` turn/idle,
  // `post_tokens` Claude Code's count of the compacted conversation (no system prompt or tools).
  'context.compacted': runner('trigger', 'before_tokens', 'after_tokens', 'summary_chars', 'paused_turn', 'outcome', 'reason', 'post_tokens'),
  // Legacy: emitted by runners before calvin#49, accepted while they roll over (≤ 2 h idle exit).
  // Remove with the `calvin_turns` datasource.
  'model.requested': runner('request_seq', 'steer'),
  'model.first_token': runner('request_seq', 'input_tokens', 'cache_read_tokens', 'cache_creation_tokens'),
  'output.renderable': runner('kind'),
  'output.first_visible': runner('mode'),
  'tool.started': runner('is_error'),
  'steer.delivered': runner('steer_trace_id', 'boundary_wait_ms'),
  // One per API write the runner's SessionApi takes (human-rate; Q8); duration_ms: accepted here -> applied; surface by `via`.
  'api.write': runner('method', 'delivery', 'replayed'),
  // ---------------------------------------------------------------- collector
  // One per accepted host batch, stamped with the host's identity: a missing
  // `batch_seq` within a `host_boot_id` is a lost batch even when nothing was counted.
  'telemetry.batch': collector('host_boot_id', 'batch_seq', 'events', 'turns', 'dropped'),
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof CATALOG;
export type DataKey<N extends EventName> = (typeof CATALOG)[N]['data'][number];
export type Scalar = string | number | boolean;
/** The `data` an event may carry: only its catalog keys, scalars only. */
export type DataOf<N extends EventName> = Partial<Record<DataKey<N>, Scalar>>;

export const isEventName = (name: unknown): name is EventName => typeof name === 'string' && Object.hasOwn(CATALOG, name);

/** Events any process may emit regardless of the catalog's `service`. */
export const ANY_SERVICE: ReadonlySet<EventName> = new Set<EventName>(['telemetry.dropped', 'command.handled']);
