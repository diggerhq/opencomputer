// Copied from diggerhq/calvin src/telemetry/catalog.ts at ada36fd, plus the gateway's
// message.accepted, admission.checked, credentials.resolved and definition.refreshed, and
// message.received's cached, cache_layer and colo, queue.started's inline and parallel,
// dispatch.sent's wait_ms (work 068)
// (bluecode perf/gateway-ack; add them to calvin's copy), and the subscription.* events
// (work 082 P2, blue#272; add them to calvin's copy), the work 084 instrumentation entries
// (calvin's mirror.*, api.*, wire.*, cli.* and turn.started's keys verbatim, catalog v2; blue's
// and the edge's own, below, per /tmp/build084/instrumentation-catalog.md); keep identical until work 050 P3
// shares the protocol package.

// The telemetry event catalog (work 054, "Seams and the
// event catalog"): every event Calvin may emit, which process emits it, and
// the only `data` keys it may carry. It is data, so `emit` is typed by event
// name and the collector re-validates with the same table.
//
// Invariants: names are `<area>.<transition>` and say what happens, never the
// vendor; `data` values are scalars (string, number, boolean) and never
// content. Adding an event or a key here is the whole schema change: the
// Tinybird column is the JSON `data` string.

// `edge`, `session` and `workerd`: serverless agent sessions (work 073), bluecode only.
/** calvin api/cli-telemetry.ts CLI_COMMON: keys the host adds to every `cli.*` event. */
const CLI_COMMON = ['client_version', 'os', 'arch'] as const;

export type ServiceName = 'gateway' | 'host' | 'runner' | 'collector' | 'edge' | 'session' | 'workerd';

interface EventSpec {
  service: ServiceName;
  data: readonly string[];
}

const gateway = (...data: string[]) => ({ service: 'gateway', data }) as const satisfies EventSpec;
const host = (...data: string[]) => ({ service: 'host', data }) as const satisfies EventSpec;
const runner = (...data: string[]) => ({ service: 'runner', data }) as const satisfies EventSpec;
const collector = (...data: string[]) => ({ service: 'collector', data }) as const satisfies EventSpec;
const edge = (...data: string[]) => ({ service: 'edge', data }) as const satisfies EventSpec;
const session = (...data: string[]) => ({ service: 'session', data }) as const satisfies EventSpec;
const workerd = (...data: string[]) => ({ service: 'workerd', data }) as const satisfies EventSpec;

export const CATALOG = {
  // ---------------------------------------------------------------- gateway
  // `cached`: the workspace's organization came from a cache (`cache_layer` memory|colo), not its link object.
  // `colo`: the Cloudflare colo that took Slack's request (work 068 §3f; also the envelope's `region`).
  'message.received': gateway('surface_event_id', 'redelivery', 'redelivery_reason', 'kind', 'cached', 'cache_layer', 'colo', 'forwarded'),
  'message.deduped': gateway('dedupe_key'),
  'message.ignored': gateway('reason'),
  // `inline`: taken by the drain an accept started (false: the alarm's); `parallel`: thread chains running (work 068).
  'queue.started': gateway('attempt', 'inline', 'parallel'),
  'queue.retried': gateway('attempt'),
  'queue.failed': gateway('attempt'),
  'command.handled': gateway('command'),
  'ack.done': gateway('indicator', 'call_ms'),
  'links.resolved': gateway('count', 'timed_out', 'forwarded'),
  'dispatch.created': gateway('attempt'),
  // `wait_ms`: since the dispatch row was created (work 068).
  'dispatch.sent': gateway('attempt', 'wait_ms'),
  'dispatch.parked': gateway(),
  'dispatch.resent': gateway('attempt'),
  'dispatch.replied': gateway(),
  'host.connected': gateway('host_version'),
  'host.disconnected': gateway('host_version', 'close_code'),
  'interaction.received': gateway('kind'),
  // Queued in the organization's object (team lookup, RPC and object wake since `received_at`);
  // `ack`: the working status was started here. `queue.started` − this is the queue's delay (inline drain or alarm).
  'message.accepted': gateway('ack'),
  // The credit gate: `cached` when billing's earlier admission was used; `decision` allowed|fallback|refused.
  'admission.checked': gateway('cached', 'decision'),
  // The host's credentials; `source` local (stored model key) | remote (asked the account) | none.
  'credentials.resolved': gateway('source'),
  // The organization's repositories re-read: account object (installations, token mints) and GitHub (listing) timed apart.
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
  // dashboard|slack (minted); `purpose` connect|link and `subject` dashboard|slack (minted, work 083); `reason` why it
  // was refused (malformed|other_org|unknown|expired|wrong_purpose), or the connect's error code (failed); `failures`
  // before this redemption (redeemed) or with it (failed); `kept` the code survives.
  'subscription.connect_code': gateway('action', 'via', 'reason', 'failures', 'kept', 'purpose', 'subject'),
  // A dashboard user linked to a Slack user (work 083; person_id the Slack id). `via` install|code; `replaced` an
  // older link of either went; `moved` a stray `web:` row was re-keyed (a code link; should never happen).
  'subscription.linked': gateway('via', 'replaced', 'moved'),
  // `!link <code>` refused; `reason` malformed|unknown|expired|wrong_purpose|not_member; `failures` with this one
  // and `kept` the code survives (absent when there was no live code).
  'subscription.link_refused': gateway('reason', 'failures', 'kept'),
  // ---------------------------------------------------------------- host
  'deliver.received': host(),
  'workspace.ensured': host('cloned', 'repos'),
  'fork.repo': host('repo', 'fetch_ms', 'worktree_ms', 'lock_wait_ms', 'fetch_error_type'),
  'fork.done': host('repos', 'fork_error_type'),
  'runner.launched': host('launch_mode', 'attempt'),
  'runner.ready': host('polls'),
  'deliver.forwarded': host('credentials_sent', 'secrets_count'),
  'runner.exited': host('busy', 'exit_reason', 'last_status'),
  'turn.abandoned': host('exit_reason'),
  'token.minted': host('cache_hit', 'repos'),
  'housekeeping.fetch': host('repo', 'fast_forwarded'),
  'host.sample': host(
    'load1',
    'cpu_pct',
    'mem_used_mb',
    'cpus',
    'mem_total_mb',
    'disk_free_mb',
    'runners',
    'busy_runners',
    'oldest_fetch_age_s',
    'gateway_connected',
    'since_gateway_message_s',
    'telemetry_spooled_bytes',
    'telemetry_dropped',
  ),
  // ---------------------------------------------------------------- host: the computer API (work 084 instrumentation)
  // /tmp/build084/instrumentation-catalog.md v2 is the contract (blue mirrors it). Dumb dump: one event per unit of
  // work (a batch, an ack, a held frame, an adoption); every aggregate is a Tinybird query. Samples hold gauges only.
  // One per journal batch the host sends to the DO (Q2, Q3): the runner → host → send hop.
  // held_ms: the wait for the gateway socket to drain, on the first batch after one (calvin 75a70d1, 084 perf fix 2).
  'mirror.batch': host('events', 'first_seq', 'last_seq', 'oldest_age_ms', 'newest_age_ms', 'resent', 'urgent', 'held_ms'),
  // One per journal-ack covering a sent batch (Q3): the DO commit round trip and end-to-end age at the DO.
  'mirror.ack': host('seq', 'batches', 'events', 'commit_ms', 'age_ms'),
  // One per frame held for an epoch adoption, when it goes (Q6); duration_ms = held → released.
  'api.held': host('asked'),
  // One per session per stale epoch seen (Q6).
  'api.stale_epoch': host('epoch', 'known'),
  // One per `epoch` frame adopted (or failed): from the frame to the commit.
  'api.epoch_adopted': host('epoch', 'start_seq', 'tail_events', 'torn', 'held_frames', 'retired_runner', 'attempt'),
  // Per minute on a v4 host, gauges only (Q10).
  'api.sample': host('host_protocol', 'open_journals', 'runner_writers', 'host_writers', 'journal_bytes', 'mirror_spooled_bytes', 'mirror_unacked_max', 'held_frames'),
  // The relay's events, sent the moment they happen and emitted by the host (api/wire-events.ts); surface `cli`.
  'wire.connect': host('connection_id'),
  'wire.refused': host('status'),
  'wire.close': host('connection_id', 'code', 'attaches', 'frames_in', 'bytes_in', 'frames_out', 'bytes_out'),
  'wire.attach': host('connection_id', 'attach_ms', 'via', 'resume', 'replay', 'deltas'),
  // telemetry_refused: opc `telemetry` frames dropped unread in the window (too large, over the rate; calvin 630b222).
  'wire.flush': host('connection_id', 'frames', 'bytes', 'events', 'deltas', 'oldest_age_ms', 'wait_ms_max', 'queued_bytes', 'paused', 'merged', 'duplicates', 'telemetry_refused'),
  'wire.detached': host('connection_id', 'reason'),
  'wire.error': host('connection_id', 'method', 'code'),
  'wire.terminal': host('connection_id', 'bytes_in', 'bytes_out', 'exited'),
  'wire.files': host('op', 'bytes'),
  // result: ok | invalid. A refused frame (too large, over the rate) is no event: wire.flush counts it (calvin 630b222).
  'wire.telemetry': host('connection_id', 'events', 'rejected', 'result'),
  'wire.sample': host('connections', 'members', 'attached', 'terminals', 'queued_bytes_max'),
  // opc's own measurements (Q7), sent as the wire `telemetry` notification, checked by api/cli-telemetry.ts; surface `cli`.
  'cli.turn': host(...CLI_COMMON, 'first_event_ms', 'first_output_received_ms', 'first_output_ms', 'interrupted'),
  'cli.attach': host(...CLI_COMMON, 'attach_ms', 'connect_ms', 'reconnect', 'gap_ms', 'replayed_events'),
  'cli.control': host(...CLI_COMMON, 'kind', 'round_trip_ms', 'applied_ms', 'ok'),
  'cli.error': host(...CLI_COMMON, 'class', 'close_code'),
  'cli.render': host(...CLI_COMMON, 'lag_ms', 'draw_ms'),
  'cli.connection': host(...CLI_COMMON, 'up_ms', 'frames', 'bytes', 'close_code', 'reconnect'),
  'cli.overflow': host(...CLI_COMMON, 'dropped'),
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
  'harness.started': runner('resume', 'mcp_servers'),
  'model.response_started': runner('input_tokens', 'cache_read_tokens', 'cache_creation_tokens'),
  'model.response_ended': runner(),
  // `kind`: text, thinking or tool; `hidden`: a tool the thread doesn't show.
  'model.block_started': runner('index', 'kind', 'hidden'),
  'model.block_stopped': runner('index'),
  'tool.completed': runner('is_error'),
  'surface.call': runner('method', 'status', 'rate_limited', 'retry_after_s'),
  // Usage as the harness reports it; `cost_total_usd` is its running total for the process.
  'turn.ended': runner('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'api_ms', 'cost_total_usd'),
  // Session finished the end-of-turn work (final flush, footer, status) and went idle.
  'turn.closed': runner(),
  // Legacy: emitted by runners before calvin#49, accepted while they roll over (≤ 2 h idle exit).
  // Remove with the `calvin_turns` datasource.
  'model.requested': runner('request_seq', 'steer'),
  'model.first_token': runner('request_seq', 'input_tokens', 'cache_read_tokens', 'cache_creation_tokens'),
  'output.renderable': runner('kind'),
  'output.first_visible': runner('mode'),
  'tool.started': runner('is_error'),
  'steer.delivered': runner('steer_trace_id', 'boundary_wait_ms'),
  // One per API write call that reaches the runner's SessionApi (Q8); duration_ms = reached → applied.
  'api.write': runner('method', 'delivery', 'replayed'),
  // ---------------------------------------------------------------- serverless sessions (work 073)
  // Spans: emitted at the end of the step with `duration_ms`. `session_key` is the managed session id.
  // edge: POST /v1/sessions.
  'session_create.resolved': edge(),
  'session_create.pool_claimed': edge('leased'),
  'session_create.initialized': edge('outcome'),
  'session_create.published': edge('published'),
  'session_create.responded': edge('status'),
  // edge: one model call through the gateway; `capability`: the prewarmed-runtime route.
  'model_gateway.authenticated': edge('capability'),
  'model_gateway.route_resolved': edge('access', 'source'),
  'model_gateway.deployment_loaded': edge(),
  'model_gateway.catalog_checked': edge(),
  'model_gateway.credential_resolved': edge('access'),
  'model_gateway.billing_checked': edge('fallback'),
  'model_gateway.upstream_responded': edge('status', 'upstream', 'protocol'),
  'model_gateway.first_event': edge('bytes'),
  'model_gateway.route_recorded': edge(),
  'model_gateway.responded': edge('status', 'protocol', 'capability'),
  // session: the Session object. `first_output` and `completed` run from the turn's creation.
  'session_admit.resolved': session(),
  'session_admit.runtime_ready': session('prewarm'),
  'session_turn.dispatched': session('status', 'activation', 'init_ms', 'reused'),
  'session_turn.first_output': session(),
  'session_turn.completed': session('status'),
  // workerd: the OpenCode runtime object.
  'workerd.artifacts_loaded': workerd('files', 'bytes'),
  'workerd.tools_loaded': workerd('tools'),
  'workerd.opencode_created': workerd(),
  'workerd.opencode_ready': workerd('mcp_servers'),
  'workerd.session_created': workerd(),
  'workerd.context_attached': workerd('rebooted'),
  'workerd.agent_rendered': workerd('memory'),
  'workerd.turn_started': workerd('booted'),
  'workerd.first_delta': workerd(),
  // ---------------------------------------------------------------- computer API: blue and the edge (work 084 instrumentation)
  // blue's own entries in /tmp/build084/instrumentation-catalog.md (v2 "dumb dump", its Changes): one event per unit of
  // work, nothing summed in memory; every aggregate is a Tinybird query. Ids and closed values only.
  // One per journal batch the Computer DO appends to a SessionLog (Q2, Q3); duration_ms = append_ms = the DO →
  // SessionLog round trip; store_ms inside the SessionLog; commit_lag_ms_* = now − createdAt of the batch's oldest
  // and newest event at the answer (runner clock vs DO clock); refused: stale_epoch | gap (nothing stored);
  // spills_due: rows the log spills to R2 after the commit (their own sessionlog.spill); storage_bytes: the log's
  // SQLite size now (a gauge). Computer DO time: do_chain_wait_ms frame received → its turn behind the session's
  // earlier batches; do_pre_ms received → append RPC sent; do_post_ms append answered → row updated and ack sent;
  // do_ack_ms received → ack sent (acked batches). slack_queue_rows / slack_queue_oldest_ms: the DO's Slack queue
  // (pending + running rows, oldest pending wait) at that moment. Workers clocks stand still during synchronous
  // work, so the do_* spans count awaits (I/O, the chain), not CPU: DO CPU comes from Cloudflare GraphQL
  // (durableObjectsInvocationsAdaptiveGroups sum.cpuTime). The queue gauge is index-only (slack-queue-gauge.ts).
  'sessionlog.append': gateway(
    'epoch', 'events', 'turns', 'ended', 'append_ms', 'commit_lag_ms_max', 'commit_lag_ms_min', 'refused',
    'do_chain_wait_ms', 'do_pre_ms', 'do_post_ms', 'do_ack_ms', 'slack_queue_rows', 'slack_queue_oldest_ms',
    'store_ms', 'rows', 'dupes', 'mismatches', 'bytes', 'spills_sync', 'spill_sync_bytes', 'spill_sync_ms', 'spills_due',
    'refolded', 'refold_ms', 'storage_bytes',
  ),
  // One per batch's after-commit R2 spills, from the SessionLog DO (Q2); duration_ms = first put → last done.
  'sessionlog.spill': gateway('spills', 'spill_bytes', 'spill_ms_max', 'failed'),
  // Q6, one per occurrence. kind gap_4010 (host closed 4010) | stale_epoch (a stale batch, the epoch resent) |
  // recover_alarm (the recover alarm acted; reason host_gone|runner_stopped) | session_recovered | epoch_sent (reason
  // recover|stale|hello) | tail_retry (an epochTail read failed). duration_ms and outcome where the step has them.
  'sessionlog.recovery': gateway('kind', 'reason', 'sessions', 'deferred', 'events', 'epoch', 'attempt', 'final'),
  // One per API write the Computer DO sends to the host (Q6 held writes, Q8 the gateway's share): duration_ms = sent →
  // answered; held/held_ms: waited on an epoch adoption first; replayed: a keyed retry took the original's answer;
  // do_ms: in the DO before the frame left, beyond the hold; slack_queue_*: as on sessionlog.append.
  'computer.write': gateway(
    'method', 'held', 'held_ms', 'replayed', 'timed_out', 'do_ms', 'slack_queue_rows', 'slack_queue_oldest_ms',
  ),
  // One per outage seen by the API: the first 503 computer_unavailable → the host's hello (Q4).
  'computer.unavailable': gateway('wait_ms'),
  // One per POST /v1/computer/tickets (Q5): result minted | api_key_required | project_key | not_configured | invalid |
  // rate_limited | computer_unavailable; key_written: the key's KV record was written first (ensure).
  'ticket.minted': gateway('result', 'sessions', 'key_written'),
  // One per key KV write (Q9); trigger sync|observe|ensure|rewrite. Never the key's hash.
  'keys.synced': gateway('key_id', 'trigger', 'ok', 'kv_writes'),
  // One per revoke (Q9): known to this computer, and the host told (protocol v4 `revoked`).
  'keys.revoked': gateway('key_id', 'known', 'host_told'),
  // One per blue /v1/computer API request (Q3 delivery, Q4): route (closed: sessions turns asks subagents control
  // events workspace secrets tickets other), op (the API op), duration_ms = the request's time in blue; do_ms/log_ms:
  // awaiting the Computer DO / the SessionLog; wait_ms: a long-poll's asked wait; events/empty: events.list's page;
  // oldest_age_ms/newest_age_ms: now − createdAt of its first/last event (delivery freshness).
  'httpapi.request': gateway(
    'route', 'op', 'method', 'status', 'do_ms', 'log_ms', 'wait_ms', 'events', 'empty', 'oldest_age_ms', 'newest_age_ms', 'replayed',
  ),
  // One per wire Worker request (Q5): kind upgrade|files|other, via key|ticket|both|none, result accepted|refused|
  // unavailable|failed|not_found, reason (closed), code (close code or HTTP status), kv/tunnel hops. duration_ms ends at
  // the 101 or the response headers.
  'wireworker.request': gateway(
    'kind', 'via', 'result', 'reason', 'code', 'op', 'key_id', 'kv_gets', 'kv_ms', 'tunnel_ms', 'tunnel_status',
  ),
  // One per api-edge computer-API request (opencomputer cloudflare-workers/api-edge, Q4): route family as above,
  // status, duration_ms = the edge's time to the response headers; upstream blue|wire|edge (answered here); blue_ms
  // from blue's Server-Timing; auth ok|missing|invalid|conflicting|project_key|not_member|origin|key_required|
  // disabled|none; via key|dashboard|none; rate_limited: the per-key limit refused it; key_id: the API key row id.
  'edge.request': edge('route', 'method', 'status', 'upstream', 'blue_ms', 'auth', 'via', 'rate_limited', 'key_id'),
  // Billing funnel (work 086; opencomputer api-edge src/billing_events.ts), also sent to PostHog
  // under the same names. trial_started at org creation: plan_intent pro|max from the signup's `?plan=`, via
  // browser|cli. work_minutes_recorded per segment tracked to Autumn: minutes, surface computer|automation, plan
  // trial|pro|max. first_work_minute once per org. checkout_opened: plan, from paywall|warning|billing_page|signup.
  // From the Autumn webhook: plan_changed kind trial_converted|upgrade|downgrade|cancel|lapsed; payment_failed
  // plan (top_up for a failed auto top-up, with reason); credits_purchased amount in credits, auto true|false.
  'billing.trial_started': edge('plan_intent', 'via'),
  'billing.work_minutes_recorded': edge('minutes', 'surface', 'plan'),
  'billing.first_work_minute': edge('surface', 'minutes_since_signup'),
  'billing.checkout_opened': edge('plan', 'from'),
  'billing.plan_changed': edge('from', 'to', 'kind'),
  'billing.payment_failed': edge('plan', 'reason'),
  'billing.payment_recovered': edge('plan'),
  'billing.credits_purchased': edge('amount', 'auto'),
  // Shown on a surface: surface api|cli|slack|web. The edge sends api, cli and web; blue's computer gateway sends
  // slack (the catalog's `service` is not enforced). warning_shown: reason trial_minutes|trial_days|trial_tokens|
  // allowance_80|credits_low|payment_failed; in Slack once per reason per run of warnings, DMed to the installer or
  // in the thread. paywall_shown: reason trial_minutes|trial_days|trial_tokens|credits_empty|payment|lapsed, or
  // credits_exhausted for the credit rule; in Slack once per thread.
  'billing.warning_shown': edge('reason', 'surface'),
  'billing.paywall_shown': edge('reason', 'surface'),
  // From the computer's object: a paid computer's VM deleted (parked, disks kept) after `days_unpaid` days halted.
  'billing.vm_terminated': gateway('days_unpaid'),
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

/** The model-subscription events (work 082): what `ModelSubscriptions` may emit. */
export type SubscriptionEventName = Extract<EventName, `subscription.${string}`>;

export const isEventName = (name: unknown): name is EventName => typeof name === 'string' && Object.hasOwn(CATALOG, name);

/** Events any process may emit regardless of the catalog's `service`. */
export const ANY_SERVICE: ReadonlySet<EventName> = new Set<EventName>(['telemetry.dropped', 'command.handled']);
