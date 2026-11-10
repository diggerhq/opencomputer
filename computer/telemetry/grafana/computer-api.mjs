// The computer API dashboard, the Slack-by-protocol panels on Speed and the
// computer API alert rules (work 084 instrumentation). Thresholds come from
// `computer_api` in telemetry/thresholds.json: `decision` rows are the four
// "do we need to optimize?" checks (decided 2026-10-26), `alert` rows the
// failure signals. The same checks as one call: the Tinybird endpoint
// `optimize_checks`; one endpoint per question Q1-Q10 (tinybird/endpoints).

import { EVENTS, TURNS } from './sql.mjs';

const E = (names, synthetic = false, where = '$__timeFilter(occurred_at)') => EVENTS(names, where, synthetic);
const int = (k) => `JSONExtractInt(data, '${k}')`;
const str = (k) => `JSONExtractString(data, '${k}')`;
const bool = (k) => `JSONExtractBool(data, '${k}')`;
const union = (...parts) => `SELECT * FROM (\n${parts.join('\nUNION ALL\n')}\n) ORDER BY time`;
const series = (metric, value, names, { where = '1', synthetic = true } = {}) =>
  `SELECT $__timeInterval(occurred_at) AS time, ${metric} AS metric, ${value} AS value FROM ${E(names, synthetic)} WHERE ${where} GROUP BY time, metric`;
export const find = (api, id) => {
  const t = api.find((x) => x.id === id);
  if (!t) throw new Error(`thresholds.json computer_api has no ${id}`);
  return t;
};

/** The runner's protocol per turn, from its `turn.started` (a turn without one, or from before 084, is v3). */
const PROTOCOL = `multiIf(JSONExtractUInt(data, 'host_protocol') = 4 AND JSONExtractUInt(data, 'api_clients') > 0, 'v4+client', JSONExtractUInt(data, 'host_protocol') = 4, 'v4', 'v3')`;
const STARTED = (where = 'occurred_at >= $__fromTime - INTERVAL 1 DAY AND occurred_at < $__toTime + INTERVAL 1 HOUR') =>
  `(SELECT turn_id, trace_id, ${PROTOCOL} AS protocol FROM calvin_events WHERE event_name = 'turn.started' AND turn_id != '' AND ${where} LIMIT 1 BY turn_id)`;
const SLACK = "surface = 'slack'";
const proto = "if(p.protocol = '', 'v3', p.protocol)";

/** Minutes in which an org's Computer DO appended journal batches: the "busy" side of check 1. */
const BUSY = (where) => `(SELECT DISTINCT org_id, toStartOfMinute(occurred_at) FROM ${EVENTS(['sessionlog.append'], where, true)} WHERE org_id != '')`;
const busyDelta = (where, eventsWhere) =>
  `SELECT toStartOfHour(occurred_at) AS time, if(event_name = 'dispatch.sent', 'Slack dispatch wait p95: busy − quiet (hourly)', 'K1 p95: busy − quiet (hourly)') AS metric,
  if(countIf(busy) > 0 AND countIf(NOT busy) > 0, quantileIf(0.95)(ms, busy) - quantileIf(0.95)(ms, NOT busy), NULL) AS value
FROM (SELECT occurred_at, event_name, if(event_name = 'dispatch.sent', ${int('wait_ms')}, toInt64(duration_ms)) AS ms,
  (org_id, toStartOfMinute(occurred_at)) IN ${BUSY(where)} AS busy FROM ${EVENTS(['dispatch.sent', 'ack.done'], eventsWhere ?? where)})
GROUP BY time, metric`;

/** p95 of K2 or K3 on warm Slack turns of v4 runners ÷ v3, in buckets, null below `min_n` turns per side. */
const ratio = (col, t) =>
  `if(countIf(${col} IS NOT NULL AND v4) >= ${t.min_n} AND countIf(${col} IS NOT NULL AND NOT v4) >= ${t.min_n}, quantileIf(0.95)(${col}, v4) / greatest(quantileIf(0.95)(${col}, NOT v4), 1), NULL)`;
const warmTurns = (turnsWhere, startedWhere) =>
  `(SELECT t.sent_at AS sent_at, t.first_visible_ms AS first_visible_ms, t.overhead_ms AS overhead_ms, p.protocol IN ('v4', 'v4+client') AS v4
FROM ${TURNS(`${turnsWhere} AND ${SLACK} AND path = 'warm' AND outcome != 'silent'`)} AS t LEFT JOIN ${STARTED(startedWhere)} AS p ON p.turn_id = t.turn_id)`;

const ms = (title, sql, threshold, opts = {}) => ({ title, sql, unit: 'ms', threshold, ...opts });

const decisionRow = (api) => {
  const [batch, write, busyMin, dispatch, k1] = ['do_batch_p95', 'do_write_p95', 'do_busy_ms_per_min_p95', 'dispatch_wait_busy_delta_p95', 'k1_busy_delta_p95'].map((id) => find(api, id));
  const [append, commit, k2, k3, hop] = ['sessionlog_append_p95', 'commit_p95', 'slack_k2_v4_ratio', 'slack_k3_v4_ratio', 'journal_hop_p95'].map((id) => find(api, id));
  return [
    { row: 'Do we need to optimize?' },
    ms(
      '1 · Computer DO contention: DO time per batch and write, Slack wait busy − quiet (p95)',
      union(
        series(
          "if(event_name = 'sessionlog.append', 'DO time per journal batch p95', 'DO time per API write p95')",
          `quantile(0.95)(if(event_name = 'sessionlog.append', ${int('do_ack_ms')}, ${int('do_ms')}))`,
          ['sessionlog.append', 'computer.write'],
          { where: `(event_name = 'sessionlog.append' AND JSONHas(data, 'do_ack_ms')) OR (event_name = 'computer.write' AND JSONHas(data, 'do_ms'))` },
        ),
        busyDelta('$__timeFilter(occurred_at)'),
      ),
      batch.threshold,
      {
        description: `Optimize the Computer DO when any line stays above ${batch.threshold} ms (n ≥ ${batch.min_n} batches, ${write.min_n} writes, ${dispatch.min_n} dispatches per side over ${batch.window_h} h; the same verdict: Tinybird \`optimize_checks\`). Why ${batch.threshold} ms: the host flushes a streaming session's journal every 100 ms, so a DO that spends ${batch.threshold} ms or more on each batch (\`do_ack_ms\`: frame received → ack sent) or API write (\`do_ms\`) is handling them back to back and starts to queue everything else, including Slack. The busy − quiet lines are the direct test: p95 Slack dispatch wait (\`dispatch.sent\` wait_ms) and K1 in org-minutes when journal batches reached that org's DO, minus minutes when none did, per hour (both sides need samples in the hour); ${dispatch.threshold} ms (K1: ${k1.threshold} ms) is 10% of the K1 budget (1 s). Caveat: Workers clocks stand still during synchronous code, so do_* counts awaits (storage, the SessionLog RPC, the per-session chain), not CPU; DO CPU is Cloudflare's GraphQL analytics (the manual CPU check in the 084 instrumentation answers). Busy ms per org-minute (threshold ${busyMin.threshold}) and the span breakdown are in the DO load row below.`,
      },
    ),
    ms(
      '2 · SessionLog: append and commit lag p95',
      union(
        series("'SessionLog append p95 (append_ms)'", `quantile(0.95)(${int('append_ms')})`, ['sessionlog.append'], { where: `${str('refused')} = ''` }),
        series("'commit lag p95: host sent → journal-ack (commit_ms)'", `quantile(0.95)(${int('commit_ms')})`, ['mirror.ack']),
      ),
      append.threshold,
      {
        description: `Optimize the SessionLog append path when either line stays above ${append.threshold} ms (n ≥ ${append.min_n} over ${append.window_h} h; commit uses ${commit.threshold} ms). Why: ${append.threshold} ms is two 100 ms flush windows. While an append takes longer than that, the host has the next batch ready before the last one is acknowledged, so batches pile up per session and every API reader and wire client sees events late. \`append_ms\` is the DO → SessionLog round trip (refused appends excluded); \`commit_ms\` is the host's view: oldest covered batch sent → journal-ack received.`,
      },
    ),
    {
      title: '3 · Slack K2/K3 warm p95: v4 runners ÷ v3 (3 h buckets)',
      unit: 'none',
      threshold: k2.threshold,
      sql: `SELECT toStartOfInterval(sent_at, INTERVAL 3 HOUR) AS time, ${ratio('first_visible_ms', k2)} AS \`K2 v4 ÷ v3\`, ${ratio('overhead_ms', k3)} AS \`K3 v4 ÷ v3\`
FROM ${warmTurns('$__timeFilter(sent_at)')} GROUP BY time ORDER BY time`,
      description: `Optimize the runner's v4 path when a ratio stays above ${k2.threshold} (each side needs ${k2.min_n} warm Slack turns in the bucket; the rules check ${k2.window_h} h). Why ${k2.threshold}, not 1.0: v3 and v4 runners are different hosts and orgs, so some spread is population, not 084. The deploy-regression rule allows 1.3× and CI perf-check fails at 1.5× p50; ${k2.threshold} catches a smaller shift earlier. Above it, confirm causally with the same-org before/after check (rollout step 3 in the 084 instrumentation answers). The per-protocol K1-K6 detail, with an attached client split out, is on Calvin · Speed and the \`slack_by_protocol\` endpoint.`,
    },
    ms(
      '4 · Runner journaling on the hot path: runner wrote → host sent, urgent batches (p95)',
      union(
        series("'urgent batches: newest event age at send p95'", `quantile(0.95)(${int('newest_age_ms')})`, ['mirror.batch'], { where: bool('urgent') }),
        series("'flushed batches: oldest event age at send p95'", `quantile(0.95)(${int('oldest_age_ms')})`, ['mirror.batch'], { where: `NOT ${bool('urgent')}` }),
      ),
      hop.threshold,
      {
        description: `Optimize the runner's journal writer when the urgent line stays above ${hop.threshold} ms (n ≥ ${hop.min_n} over ${hop.window_h} h). Urgent batches (turn end, ask, status) skip the 100 ms flush wait, so their newest event's age at send is the runner's append + fold + outbox + host hop with no deliberate delay; ${hop.threshold} ms is an eighth of the K3 warm budget (400 ms). The flushed line includes up to 100 ms of intended wait and is context only. Not in production telemetry: the runner's own append and fold time per turn; that cost is measured by CI \`npm run perf-check\` (turn CPU v3 vs v4 vs v4 with a client), whose gate is the Slack-visible p50, not CPU.`,
      },
    ),
  ];
};

const doLoadRow = (api) => {
  const busyMin = find(api, 'do_busy_ms_per_min_p95');
  return [
    { row: 'Computer DO load (check 1 detail)' },
    ms(
      'DO busy ms per org-minute p95 (batches + writes, chain wait excluded)',
      `SELECT $__timeInterval(minute) AS time, quantile(0.95)(busy_ms) AS \`busy ms per org-minute p95\`, max(busy_ms) AS \`max\` FROM (
  SELECT org_id, toStartOfMinute(occurred_at) AS minute,
    sumIf(greatest(${int('do_ack_ms')} - ${int('do_chain_wait_ms')}, 0), event_name = 'sessionlog.append') + sumIf(${int('do_ms')}, event_name = 'computer.write') AS busy_ms
  FROM ${E(['sessionlog.append', 'computer.write'], true)} WHERE org_id != '' GROUP BY org_id, minute)
GROUP BY time ORDER BY time`,
      busyMin.threshold,
      {
        description: `Above ${busyMin.threshold} ms (half of every minute) one org's DO spends most of its time awaiting journal and write work. Await time, not CPU (see check 1).`,
      },
    ),
    {
      title: "Where a batch's DO time goes (avg)",
      unit: 'ms',
      stack: true,
      sql: `SELECT $__timeInterval(occurred_at) AS time, avg(${int('do_chain_wait_ms')}) AS chain_wait, avg(${int('do_pre_ms')}) AS pre, avg(${int('append_ms')}) AS append,
  avg(${int('do_post_ms')}) AS post FROM ${E(['sessionlog.append'], true)} GROUP BY time ORDER BY time`,
      description: 'chain_wait: behind the session\'s earlier batches; pre: received → append RPC sent; append: the SessionLog round trip; post: answered → row updated and ack sent.',
    },
    ms('Slack dispatch wait and K1 p95: busy − quiet org-minutes (hourly)', busyDelta('$__timeFilter(occurred_at)'), find(api, 'dispatch_wait_busy_delta_p95').threshold),
    {
      title: "The DO's Slack queue (max)",
      unit: 'short',
      sql: union(
        series("'rows pending + running'", `max(${int('slack_queue_rows')})`, ['sessionlog.append', 'computer.write'], { where: "JSONHas(data, 'slack_queue_rows')" }),
        series("'oldest pending wait (ms)'", `max(${int('slack_queue_oldest_ms')})`, ['sessionlog.append', 'computer.write'], { where: "JSONHas(data, 'slack_queue_oldest_ms')" }),
      ),
    },
  ];
};

const sessionLogRow = () => [
  { row: 'Q2 · What the session log costs' },
  ms(
    'SessionLog append latency',
    `SELECT $__timeInterval(occurred_at) AS time, quantile(0.5)(${int('append_ms')}) AS p50, quantile(0.95)(${int('append_ms')}) AS p95, max(${int('append_ms')}) AS max
FROM ${E(['sessionlog.append'], true)} GROUP BY time ORDER BY time`,
  ),
  {
    title: 'Journal and SessionLog volume',
    unit: 'short',
    sql: union(
      series("'journal batches'", 'count()', ['mirror.batch']),
      series("'journal events'", `sum(${int('events')})`, ['mirror.batch']),
      series("'rows written'", `sum(${int('rows')})`, ['sessionlog.append']),
      series("'refused appends'", 'count()', ['sessionlog.append'], { where: `${str('refused')} != ''` }),
    ),
  },
  {
    title: 'Bytes appended and spilled to R2',
    unit: 'bytes',
    sql: union(
      series("'appended'", `sum(${int('bytes')})`, ['sessionlog.append']),
      series("'spilled in the append'", `sum(${int('spill_sync_bytes')})`, ['sessionlog.append']),
      series("'spilled after commit'", `sum(${int('spill_bytes')})`, ['sessionlog.spill']),
    ),
  },
  {
    title: 'Per org: batches, bytes, spills, refolds, storage',
    type: 'table',
    sql: `SELECT org_id, countIf(event_name = 'sessionlog.append') AS appends, sumIf(${int('events')}, event_name = 'sessionlog.append') AS events,
  sumIf(${int('bytes')}, event_name = 'sessionlog.append') AS bytes, quantileIf(0.95)(${int('append_ms')}, event_name = 'sessionlog.append') AS append_p95_ms,
  sumIf(${int('spills_sync')}, event_name = 'sessionlog.append') + sumIf(${int('spills')}, event_name = 'sessionlog.spill') AS spills,
  sumIf(${int('failed')}, event_name = 'sessionlog.spill') AS spills_failed, countIf(${bool('refolded')}) AS refolds,
  maxIf(${int('storage_bytes')}, event_name = 'sessionlog.append') AS storage_bytes_max
FROM ${E(['sessionlog.append', 'sessionlog.spill'], true)} GROUP BY org_id ORDER BY bytes DESC LIMIT 50`,
  },
];

const freshnessRow = (api) => [
  { row: 'Q3 · How fresh is what clients see' },
  ms(
    'Event age p95 at each hop',
    union(
      series("'1 host sent (oldest in batch)'", `quantile(0.95)(${int('oldest_age_ms')})`, ['mirror.batch']),
      series("'2 DO committed (newest acked)'", `quantile(0.95)(${int('age_ms')})`, ['mirror.ack']),
      series("'2b blue commit lag (max per append)'", `quantile(0.95)(${int('commit_lag_ms_max')})`, ['sessionlog.append']),
      series("'3 API reader (oldest delivered)'", `quantile(0.95)(${int('oldest_age_ms')})`, ['httpapi.request'], { where: `${int('events')} > 0` }),
      series("'4 wire socket (oldest written)'", `quantile(0.95)(${int('oldest_age_ms')})`, ['wire.flush']),
    ),
    find(api, 'freshness_p95').threshold,
    { width: 24, description: `Each hop's p95 age of an event (now − its createdAt on the runner). Runner and Cloudflare clocks differ, so blue-side ages carry the skew. The alert fires when the DO-committed or wire-socket p95 is above ${find(api, 'freshness_p95').threshold} ms for 15 min. Per turn: the \`freshness\` endpoint with \`per_turn\`.` },
  ),
];

const httpRow = () => [
  { row: 'Q4 · HTTP API' },
  {
    title: 'Requests by layer and status class',
    unit: 'short',
    stack: true,
    sql: `SELECT $__timeInterval(occurred_at) AS time, concat(if(event_name = 'edge.request', 'edge ', 'blue '), toString(intDiv(${int('status')}, 100)), 'xx') AS metric, count() AS value
FROM ${E(['edge.request', 'httpapi.request'])} GROUP BY time, metric ORDER BY time`,
  },
  ms(
    'Latency p95 by route: edge total and blue DO time',
    union(
      series("concat('edge ', " + str('route') + ')', 'quantile(0.95)(duration_ms)', ['edge.request'], { synthetic: false }),
      series("concat('blue DO ', " + str('route') + ')', `quantile(0.95)(${int('do_ms')})`, ['httpapi.request'], { where: "JSONHas(data, 'do_ms')", synthetic: false }),
    ),
  ),
  {
    title: '503 computer_unavailable, 429s, replays, empty long-polls',
    unit: 'short',
    sql: union(
      series("'503 (blue)'", 'count()', ['httpapi.request'], { where: `${int('status')} = 503`, synthetic: false }),
      series("'429 (edge)'", 'count()', ['edge.request'], { where: `${int('status')} = 429 OR ${bool('rate_limited')}`, synthetic: false }),
      series("'idempotent replays'", 'count()', ['httpapi.request'], { where: bool('replayed'), synthetic: false }),
      series("'long-polls returned empty'", 'count()', ['httpapi.request'], { where: `${int('wait_ms')} > 0 AND ${bool('empty')}`, synthetic: false }),
    ),
  },
  {
    title: 'Outages, auth failures and rate limits by key',
    type: 'table',
    sql: `SELECT * FROM (
SELECT 'outage: time until the host came' AS what, '' AS detail, count() AS n, quantile(0.5)(${int('wait_ms')}) AS p50_ms, quantile(0.95)(${int('wait_ms')}) AS p95_ms FROM ${E(['computer.unavailable'])}
UNION ALL SELECT 'edge auth refused', ${str('auth')}, count(), NULL, NULL FROM ${E(['edge.request'])} WHERE ${str('auth')} NOT IN ('ok', '') GROUP BY 2
UNION ALL SELECT 'rate limited key', ${str('key_id')}, count(), NULL, NULL FROM ${E(['edge.request'])} WHERE ${int('status')} = 429 OR ${bool('rate_limited')} GROUP BY 2
UNION ALL SELECT 'long-poll hold', ${str('route')}, count(), quantile(0.5)(duration_ms), quantile(0.95)(duration_ms) FROM ${E(['httpapi.request'])} WHERE ${int('wait_ms')} > 0 GROUP BY 2
) ORDER BY what, n DESC`,
  },
];

const wireRow = () => [
  { row: 'Q5 · Wire' },
  {
    title: 'Connects, refusals and closes',
    unit: 'short',
    sql: union(
      series("'connects'", 'count()', ['wire.connect']),
      series(`concat('refused ', toString(${int('status')}))`, 'count()', ['wire.refused']),
      series(`concat('worker ', ${str('result')}, ' ', ${str('reason')})`, 'count()', ['wireworker.request'], { where: `${str('result')} != 'ok'` }),
      series(`concat('close ', toString(${int('code')}))`, 'count()', ['wire.close']),
    ),
  },
  ms(
    'Attach, ticket and reconnect p95',
    union(
      series("'relay attach (request → attached queued)'", `quantile(0.95)(${int('attach_ms')})`, ['wire.attach']),
      series("'opc attach (socket open → first frame drawn)'", `quantile(0.95)(${int('attach_ms')})`, ['cli.attach']),
      series("'opc reconnect gap'", `quantile(0.95)(${int('gap_ms')})`, ['cli.attach'], { where: bool('reconnect') }),
      series("'ticket mint'", 'quantile(0.95)(duration_ms)', ['ticket.minted']),
    ),
  ),
  {
    title: 'Backpressure: flush wait p95 and queued bytes max',
    unit: 'short',
    sql: union(
      series("'flush wait p95 (ms)'", `quantile(0.95)(${int('wait_ms_max')})`, ['wire.flush']),
      series("'queued bytes max'", `max(${int('queued_bytes')})`, ['wire.flush']),
      series("'paused batches'", 'countIf(' + bool('paused') + ')', ['wire.flush']),
      series("'detached'", 'count()', ['wire.detached']),
    ),
  },
  {
    title: 'Bytes in and out',
    unit: 'bytes',
    sql: union(
      series("'out: flushes'", `sum(${int('bytes')})`, ['wire.flush']),
      series("'in/out: terminals'", `sum(${int('bytes_in')} + ${int('bytes_out')})`, ['wire.terminal']),
      series(`concat('files ', ${str('op')})`, `sum(${int('bytes')})`, ['wire.files']),
    ),
  },
  {
    title: 'Concurrent connections, members, terminals (max per host)',
    unit: 'short',
    sql: union(
      ...['connections', 'members', 'attached', 'terminals'].map((k) => series(`'${k}'`, `max(${int(k)})`, ['wire.sample'])),
    ),
  },
];

const recoveryRow = (api) => [
  { row: 'Q6 · Recovery' },
  {
    title: 'Recovery events by kind',
    unit: 'short',
    stack: true,
    sql: union(
      series(`concat('blue ', ${str('kind')})`, 'count()', ['sessionlog.recovery']),
      series("'blue append refused (gap)'", 'count()', ['sessionlog.append'], { where: `${str('refused')} = 'gap'` }),
      series("'blue held write timed out'", 'count()', ['computer.write'], { where: bool('timed_out') }),
      series("'host stale epoch drop'", 'count()', ['api.stale_epoch']),
      series("'host epoch adopted'", 'count()', ['api.epoch_adopted']),
      series("'host batch resent'", 'count()', ['mirror.batch'], { where: bool('resent') }),
    ),
    description: `Alerts: journal gaps above ${find(api, 'api_gaps_1h').threshold} an hour, any recover-alarm fire, any held-write timeout.`,
  },
  {
    title: 'Recovery: counts and durations',
    type: 'table',
    sql: `SELECT * FROM (
SELECT concat('blue ', ${str('kind')}) AS kind, ${str('reason')} AS detail, count() AS n, countIf(outcome = 'failed') AS failed, quantile(0.95)(duration_ms) AS p95_ms FROM ${E(['sessionlog.recovery'], true)} GROUP BY kind, detail
UNION ALL SELECT 'held write', if(${bool('timed_out')}, 'timed out', if(${bool('replayed')}, 'replayed', '')), count(), countIf(${bool('timed_out')}), quantile(0.95)(${int('held_ms')}) FROM ${E(['computer.write'], true)} WHERE ${bool('held')} OR ${bool('timed_out')} OR ${bool('replayed')} GROUP BY 2
UNION ALL SELECT 'epoch adopted', if(${bool('torn')}, 'torn', ''), count(), countIf(outcome = 'failed'), quantile(0.95)(duration_ms) FROM ${E(['api.epoch_adopted'], true)} GROUP BY 2
UNION ALL SELECT 'frame held', if(${bool('asked')}, 'asked for epoch', ''), count(), 0, quantile(0.95)(duration_ms) FROM ${E(['api.held'], true)} GROUP BY 2
UNION ALL SELECT 'duplicates', 'append dupes + mismatches', toUInt64(sum(${int('dupes')} + ${int('mismatches')})), 0, NULL FROM ${E(['sessionlog.append'], true)}
UNION ALL SELECT 'duplicates', 'relay dropped at or below the cursor', toUInt64(sum(${int('duplicates')})), 0, NULL FROM ${E(['wire.flush'], true)}
) ORDER BY kind, detail`,
  },
];

const opcRow = () => [
  { row: 'Q7 · What an opc user sees' },
  ms(
    'opc: Enter → first output drawn p95, by version',
    series(str('client_version'), `quantile(0.95)(${int('first_output_ms')})`, ['cli.turn'], { where: "JSONHas(data, 'first_output_ms')" }),
  ),
  ms(
    'opc: steer and interrupt round trip p95, render lag p95',
    union(
      series(`concat('round trip ', ${str('kind')})`, `quantile(0.95)(${int('round_trip_ms')})`, ['cli.control']),
      series(`concat('applied ', ${str('kind')})`, `quantile(0.95)(${int('applied_ms')})`, ['cli.control'], { where: "JSONHas(data, 'applied_ms')" }),
      series("'render lag (slow draws)'", `quantile(0.95)(${int('lag_ms')})`, ['cli.render']),
    ),
  ),
  {
    title: 'opc errors by class, version and OS',
    type: 'table',
    sql: `SELECT ${str('class')} AS class, ${str('client_version')} AS version, ${str('os')} AS os, count() AS n FROM ${E(['cli.error'])} GROUP BY class, version, os ORDER BY n DESC`,
  },
  {
    title: 'opc versions and OS in use (turns)',
    type: 'table',
    sql: `SELECT ${str('client_version')} AS version, ${str('os')} AS os, ${str('arch')} AS arch, count() AS turns, countIf(${bool('interrupted')}) AS interrupted_before_output,
  quantile(0.5)(${int('first_output_ms')}) AS first_output_p50_ms FROM ${E(['cli.turn'])} GROUP BY version, os, arch ORDER BY turns DESC`,
  },
];

const interactiveRow = () => [
  { row: 'Q8 · Steer, interrupt and answer through the API' },
  ms(
    'Request accepted → runner applied p95 (api.write), by surface and method',
    series(`concat(surface, ' ', ${str('method')})`, 'quantile(0.95)(duration_ms)', ['api.write']),
  ),
  ms(
    "Blue's share: write sent → host answered p95 (computer.write)",
    series(str('method'), 'quantile(0.95)(duration_ms)', ['computer.write']),
  ),
];

const keysRow = () => [
  { row: 'Q9 · Keys and revocation' },
  {
    title: 'Key syncs, revokes and refusals after a revoke',
    type: 'table',
    width: 24,
    sql: `SELECT * FROM (
SELECT concat('synced ', ${str('trigger')}) AS what, count() AS n, countIf(NOT ${bool('ok')} OR outcome = 'failed') AS failed, quantile(0.95)(duration_ms) AS p95_ms, NULL AS last_after_revoke_ms FROM ${E(['keys.synced'], true)} GROUP BY what
UNION ALL SELECT 'revoked', count(), countIf(NOT ${bool('host_told')}), quantile(0.95)(duration_ms), NULL FROM ${E(['keys.revoked'], true)}
UNION ALL SELECT concat('used after revoke (', if(e.event_name = 'edge.request', 'edge', 'wire'), ')'), count(),
  countIf(NOT ((e.event_name = 'edge.request' AND JSONExtractUInt(e.data, 'status') IN (401, 403)) OR (e.event_name = 'wireworker.request' AND JSONExtractString(e.data, 'result') = 'refused'))), NULL,
  max(toInt64(dateDiff('millisecond', r.revoked_at, e.occurred_at)))
FROM ${E(['edge.request', 'wireworker.request'], true)} AS e
INNER JOIN (SELECT ${str('key_id')} AS key_id, min(occurred_at) AS revoked_at FROM ${E(['keys.revoked'], true)} GROUP BY key_id) AS r ON r.key_id = JSONExtractString(e.data, 'key_id')
WHERE e.occurred_at > r.revoked_at GROUP BY 1
) ORDER BY what`,
    description: '"used after revoke" counts requests carrying a revoked key; `failed` there counts the ones that were let through (should be 0). Revoke → last socket closed is not measurable: wire.close has no key_id.',
  },
];

const loadRow = () => [
  { row: 'Q10 · Load on the computer' },
  ...[
    ['open journals and held frames', ['open_journals', 'runner_writers', 'host_writers', 'held_frames'], 'short'],
    ['journal bytes on disk and spooled', ['journal_bytes', 'mirror_spooled_bytes'], 'bytes'],
  ].map(([title, keys, unit]) => ({
    title: `api.sample: ${title} (max per host)`,
    unit,
    sql: union(...keys.map((k) => `SELECT $__timeInterval(occurred_at) AS time, concat(host_id, ' ${k}') AS metric, max(${int(k)}) AS value FROM ${E(['api.sample'], true)} GROUP BY time, metric`)),
  })),
];

export const computerApiDashboard = (api) => ({
  uid: 'calvin-computer-api',
  title: 'Calvin · Computer API',
  panels: [
    ...decisionRow(api),
    ...doLoadRow(api),
    ...sessionLogRow(),
    ...freshnessRow(api),
    ...httpRow(),
    ...wireRow(),
    ...recoveryRow(api),
    ...opcRow(),
    ...interactiveRow(),
    ...keysRow(),
    ...loadRow(),
  ],
});

/** Q1 on Speed: Slack K1, K2, K3 per runner protocol (`v3`, `v4`, `v4+client`). */
export const speedProtocolPanels = (t) => {
  const thr = (kpi, path = '*') => t.find((x) => x.kpi === kpi && x.path === path && x.harness === '*')?.threshold_ms;
  const byProtocol = (col, cond) =>
    `SELECT $__timeInterval(t.sent_at) AS time, ${proto} AS protocol, quantileIf(0.95)(t.${col}, ${cond}) AS p95
FROM ${TURNS(`$__timeFilter(sent_at) AND ${SLACK} AND path = 'warm'`)} AS t LEFT JOIN ${STARTED()} AS p ON p.turn_id = t.turn_id GROUP BY time, protocol ORDER BY time`;
  const description = 'Work 084 Q1: v3 = no journal (or a runner from before 084), v4 = the runner journals the session, v4+client = an API client (opc) was attached at turn start. Slack turns only. Table form, with K4-K6 and the journal per turn: the Tinybird endpoint `slack_by_protocol`; the verdict: `optimize_checks`.';
  return [
    ms('Q1 · K2 first visible output p95 by runner protocol · warm Slack', byProtocol('first_visible_ms', "t.outcome != 'silent'"), thr('K2', 'warm'), { description }),
    ms('Q1 · K3 Calvin overhead p95 by runner protocol · warm Slack', byProtocol('overhead_ms', "t.outcome != 'silent'"), thr('K3', 'warm'), { description }),
    ms(
      'Q1 · K1 time to acknowledgement p95 by runner protocol',
      `SELECT $__timeInterval(a.occurred_at) AS time, ${proto} AS protocol, quantile(0.95)(a.duration_ms) AS p95
FROM ${EVENTS(['ack.done'])} AS a LEFT JOIN (SELECT trace_id, any(protocol) AS protocol FROM ${STARTED()} GROUP BY trace_id) AS p ON p.trace_id = a.trace_id
GROUP BY time, protocol ORDER BY time`,
      thr('K1'),
      { description },
    ),
    {
      title: 'Q1 · Slack turns by runner protocol',
      unit: 'short',
      stack: true,
      description,
      sql: `SELECT $__timeInterval(t.sent_at) AS time, ${proto} AS protocol, count() AS turns
FROM ${TURNS(`$__timeFilter(sent_at) AND ${SLACK}`)} AS t LEFT JOIN ${STARTED()} AS p ON p.turn_id = t.turn_id GROUP BY time, protocol ORDER BY time`,
    },
  ];
};

/** Alert rules: the `alert` rows, and the two Slack ratio checks over their window. */
export function computerApiRules(api, rule) {
  const H = (h) => Math.round(h * 3600);
  const recent = (t) => `occurred_at > now() - INTERVAL ${H(t.window_h)} SECOND`;
  const R = (id, title, sql, summary, extra = {}) => {
    const t = find(api, id);
    return rule({
      uid: `calvin-api-${id.replaceAll('_', '-')}`,
      title: `${title} > ${t.threshold}`,
      sql,
      value: t.threshold,
      window: H(t.window_h),
      forDur: t.for,
      summary,
      panel: '/d/calvin-computer-api',
      ...extra,
    });
  };
  const k2 = find(api, 'slack_k2_v4_ratio');
  const protocolRule = (t, col, kpi) =>
    R(
      t.id,
      `Slack ${kpi} warm p95 on v4 runners ÷ v3`,
      `SELECT ifNull(${ratio(col, t)}, 0) AS value FROM ${warmTurns(`sent_at > now() - INTERVAL ${t.window_h} HOUR`, `occurred_at > now() - INTERVAL ${t.window_h + 1} HOUR`)}`,
      `Warm Slack ${kpi} p95 on v4 runners is more than ${t.threshold}x v3 over ${t.window_h} h (n >= ${t.min_n} per side): 084's journal may be slowing Slack. Confirm with the same-org before/after check (084 instrumentation answers).`,
    );
  const gaps = find(api, 'api_gaps_1h');
  const fresh = find(api, 'freshness_p95');
  const r503 = find(api, 'api_503_ratio');
  return [
    R(
      'api_gaps_1h',
      'Computer API: journal gaps in an hour',
      `SELECT countIf((event_name = 'sessionlog.recovery' AND ${str('kind')} = 'gap_4010') OR (event_name = 'sessionlog.append' AND ${str('refused')} = 'gap')) AS value
FROM ${EVENTS(['sessionlog.recovery', 'sessionlog.append'], recent(gaps), true)}`,
      `More than ${gaps.threshold} journal gaps (4010 closes or appends refused for a gap) in the last hour: hosts and the Computer DO disagree about the journal.`,
    ),
    R(
      'recover_alarms_1h',
      'Computer API: recover alarm fired',
      `SELECT count() AS value FROM ${EVENTS(['sessionlog.recovery'], recent(find(api, 'recover_alarms_1h')), true)} WHERE ${str('kind')} = 'recover_alarm'`,
      'The Computer DO recover alarm acted (host gone or runner stopped mid-turn); see Q6 for the reason.',
    ),
    R(
      'api_503_ratio',
      'Computer API: 503 computer_unavailable ratio',
      `SELECT if(count() >= ${r503.min_n}, countIf(${int('status')} = 503) / count(), 0) AS value FROM ${EVENTS(['httpapi.request'], recent(r503))}`,
      `More than ${r503.threshold * 100}% of computer API requests answered 503 computer_unavailable over 15 min (n >= ${r503.min_n}): the host is not connected.`,
    ),
    R(
      'held_write_timeouts_15m',
      'Computer API: held writes timed out',
      `SELECT count() AS value FROM ${EVENTS(['computer.write'], recent(find(api, 'held_write_timeouts_15m')), true)} WHERE ${bool('timed_out')}`,
      'An API write waited on an epoch adoption, or for the host, and timed out.',
    ),
    R(
      'wire_refused_5m',
      'Wire: refusals in 5 min',
      `SELECT countIf(event_name = 'wire.refused' OR ${str('result')} = 'refused') AS value FROM ${EVENTS(['wire.refused', 'wireworker.request'], recent(find(api, 'wire_refused_5m')), true)}`,
      'A spike of refused wire connections (relay or wire Worker): bad tickets, revoked keys or a client in a reconnect loop.',
    ),
    R(
      'freshness_p95',
      'Computer API: event age p95 at the DO or the wire socket (ms)',
      `SELECT greatest(
  if(countIf(event_name = 'mirror.ack') >= ${fresh.min_n}, quantileIf(0.95)(${int('age_ms')}, event_name = 'mirror.ack'), 0),
  if(countIf(event_name = 'wire.flush') >= ${fresh.min_n}, quantileIf(0.95)(${int('oldest_age_ms')}, event_name = 'wire.flush'), 0)) AS value
FROM ${EVENTS(['mirror.ack', 'wire.flush'], recent(fresh), true)}`,
      `Events reach the Computer DO or a wire client more than ${fresh.threshold} ms after the runner wrote them (p95 over 15 min, n >= ${fresh.min_n}).`,
    ),
    protocolRule(k2, 'first_visible_ms', 'K2'),
    protocolRule(find(api, 'slack_k3_v4_ratio'), 'overhead_ms', 'K3'),
  ];
}
