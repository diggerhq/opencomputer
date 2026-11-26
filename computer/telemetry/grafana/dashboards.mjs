// The six Calvin dashboards (work 054, "Dashboards and alerts"), as compact
// panel lists that render.mjs expands into Grafana dashboard JSON; the seventh,
// Computer API (work 084), is in computer-api.mjs. All panels
// query Tinybird through the ClickHouse data source chosen in `$datasource`.

import { speedProtocolPanels } from './computer-api.mjs';
import { EVENTS, KPI, kpiSeriesSql, TURNS, VISIBLE, WATERFALL } from './sql.mjs';

const ms = (title, sql, threshold, opts = {}) => ({ title, sql, unit: 'ms', threshold, ...opts });
const thr = (thresholds, kpi, path = '*') => thresholds.find((t) => t.kpi === kpi && t.path === path && t.harness === '*')?.threshold_ms;
const json = (key, kind = 'Float') => `JSONExtract${kind}(data, '${key}')`;
// biome-ignore lint/suspicious/noTemplateCurlyInString: a Grafana data-link variable, not a JS template
const TRACE_LINK = '/d/calvin-traces?var-trace_id=${__data.fields.trace_id}';

/** Deploys: the first turn on each runner and gateway version. */
const deploys = `SELECT min(sent_at) AS time, concat('runner ', runner_version) AS text FROM turns WHERE $__timeFilter(sent_at) GROUP BY runner_version
UNION ALL SELECT min(sent_at) AS time, concat('gateway ', gateway_version) AS text FROM turns WHERE $__timeFilter(sent_at) GROUP BY gateway_version`;

export const dashboards = (t) => [
  {
    uid: 'calvin-speed',
    title: 'Calvin · Speed',
    annotations: [{ name: 'Deploys', sql: deploys }],
    panels: [
      ms('K2 first visible output p95 · warm', kpiSeriesSql('K2', ['warm']), thr(t, 'K2', 'warm')),
      ms('K2 first visible output p95 · new, resume', kpiSeriesSql('K2', ['new', 'resume']), thr(t, 'K2', 'new')),
      ms('K3 Calvin overhead p95 · warm', kpiSeriesSql('K3', ['warm']), thr(t, 'K3', 'warm')),
      ms('K3 Calvin overhead p95 · new, resume', kpiSeriesSql('K3', ['new', 'resume']), thr(t, 'K3', 'new')),
      ms('K1 time to acknowledgement p95', kpiSeriesSql('K1'), thr(t, 'K1')),
      ms('K4 model time to first token p95', kpiSeriesSql('K4'), undefined),
      ms('K5 longest silence p95', kpiSeriesSql('K5'), thr(t, 'K5')),
      ms('K6 steer latency p95', kpiSeriesSql('K6'), thr(t, 'K6')),
      { title: 'Turns by path', unit: 'short', stack: true, sql: `SELECT $__timeInterval(sent_at) AS time, path, count() AS turns FROM ${TURNS()} GROUP BY time, path ORDER BY time` },
      {
        title: 'Slowest turns (K2)',
        type: 'table',
        width: 24,
        links: { trace_id: TRACE_LINK },
        sql: `SELECT sent_at, trace_id, session_key, path, harness, model, first_visible_ms, overhead_ms, ttft_ms, max_silence_ms, outcome
FROM ${TURNS()} WHERE ${VISIBLE} ORDER BY first_visible_ms DESC NULLS LAST LIMIT 50`,
      },
      ...speedProtocolPanels(t),
    ],
  },
  {
    uid: 'calvin-cold-path',
    title: 'Calvin · Cold path',
    panels: [
      ...['new', 'resume'].map((p) => ({
        title: `Where a ${p} turn's time goes (avg)`,
        unit: 'ms',
        stack: true,
        sql: `SELECT $__timeInterval(sent_at) AS time, avg(fork_ms) AS fork, avg(launch_ms) AS launch, avg(harness_init_ms) AS harness_init,
  avg(intro_ms) AS intro, avg(names_ms) AS names, avg(ttft_ms) AS ttft FROM ${TURNS()} WHERE path = '${p}' GROUP BY time ORDER BY time`,
      })),
      {
        title: 'Per repository (digest): fork p95',
        type: 'table',
        sql: `SELECT ${json('repo', 'String')} AS repo, count() AS forks, quantile(0.95)(duration_ms) AS p95_ms, quantile(0.95)(${json('fetch_ms')}) AS fetch_p95_ms,
  quantile(0.95)(${json('worktree_ms')}) AS worktree_p95_ms, quantile(0.95)(${json('lock_wait_ms')}) AS lock_wait_p95_ms
FROM ${EVENTS(['fork.repo'])} GROUP BY repo ORDER BY p95_ms DESC`,
      },
      ms('Name lookups before the prompt p95', `SELECT $__timeInterval(occurred_at) AS time, quantile(0.95)(duration_ms) AS p95 FROM ${EVENTS(['names.resolved'])} GROUP BY time ORDER BY time`),
      ms('Token minting p95', `SELECT $__timeInterval(occurred_at) AS time, quantile(0.95)(duration_ms) AS p95 FROM ${EVENTS(['token.minted'])} GROUP BY time ORDER BY time`),
    ],
  },
  {
    uid: 'calvin-models',
    title: 'Calvin · Model and harness',
    panels: [
      {
        title: 'Compare by harness and model',
        type: 'table',
        width: 24,
        sql: `SELECT harness, model, count() AS turns, quantileIf(0.95)(first_visible_ms, ${VISIBLE}) AS k2_p95, quantileIf(0.95)(overhead_ms, ${VISIBLE}) AS k3_p95,
  quantile(0.95)(ttft_ms) AS k4_p95, sum(cache_read_tokens) / greatest(sum(input_tokens + cache_read_tokens + cache_creation_tokens), 1) AS cache_hit_ratio,
  avg(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens_per_turn, avg(cost_usd) AS cost_per_turn_usd,
  countIf(outcome = 'failed') / count() AS failed_ratio
FROM ${TURNS()} GROUP BY harness, model ORDER BY turns DESC`,
      },
      ms('K4 TTFT p95 by model', `SELECT $__timeInterval(sent_at) AS time, model, quantile(0.95)(ttft_ms) AS p95 FROM ${TURNS()} GROUP BY time, model ORDER BY time`),
      {
        title: 'Cache hit ratio by model',
        unit: 'percentunit',
        sql: `SELECT $__timeInterval(sent_at) AS time, model, sum(cache_read_tokens) / greatest(sum(input_tokens + cache_read_tokens + cache_creation_tokens), 1) AS ratio
FROM ${TURNS()} GROUP BY time, model ORDER BY time`,
      },
      { title: 'Cost per turn by model', unit: 'currencyUSD', sql: `SELECT $__timeInterval(sent_at) AS time, model, avg(cost_usd) AS cost FROM ${TURNS()} GROUP BY time, model ORDER BY time` },
    ],
  },
  {
    uid: 'calvin-reliability',
    title: 'Calvin · Reliability',
    panels: [
      { title: 'Turn outcomes', unit: 'short', stack: true, sql: `SELECT $__timeInterval(sent_at) AS time, outcome, count() AS turns FROM ${TURNS()} GROUP BY time, outcome ORDER BY time` },
      {
        title: 'Gateway and host trouble',
        unit: 'short',
        sql: `SELECT $__timeInterval(occurred_at) AS time, event_name, count() AS n
FROM ${EVENTS(['queue.retried', 'queue.failed', 'dispatch.parked', 'dispatch.resent', 'turn.abandoned', 'host.connected', 'host.disconnected'], undefined, true)}
GROUP BY time, event_name ORDER BY time`,
      },
      {
        title: 'K8 slow, failed or rate-limited frontend calls by method',
        type: 'table',
        sql: `SELECT ${json('method', 'String')} AS method, count() AS calls, countIf(${json('rate_limited', 'Bool')}) AS rate_limited, quantile(0.95)(duration_ms) AS p95_ms
FROM ${EVENTS(['surface.call'], undefined, true)} GROUP BY method ORDER BY calls DESC`,
      },
      {
        title: 'Telemetry dropped by reason',
        unit: 'short',
        stack: true,
        sql: `SELECT $__timeInterval(occurred_at) AS time, ${json('reason', 'String')} AS reason, sum(${json('count', 'UInt')}) AS dropped
FROM ${EVENTS(['telemetry.dropped'], undefined, true)} GROUP BY time, reason ORDER BY time`,
      },
      {
        title: 'Host batch gaps',
        type: 'table',
        sql: `SELECT host_id, ${json('host_boot_id', 'String')} AS boot, count() AS batches,
  max(${json('batch_seq', 'UInt')}) - min(${json('batch_seq', 'UInt')}) + 1 - uniqExact(${json('batch_seq', 'UInt')}) AS missing
FROM ${EVENTS(['telemetry.batch'], undefined, true)} GROUP BY host_id, boot ORDER BY missing DESC`,
      },
    ],
  },
  {
    uid: 'calvin-hosts',
    title: 'Calvin · Hosts',
    panels: [
      ['load1', 'short'],
      ['cpu_pct', 'percent'],
      ['mem_used_mb', 'decmbytes'],
      ['disk_free_mb', 'decmbytes'],
      ['busy_runners', 'short'],
      ['oldest_fetch_age_s', 's'],
      ['since_gateway_message_s', 's'],
      ['telemetry_spooled_bytes', 'bytes'],
    ].map(([k, unit]) => ({
      title: k,
      unit,
      sql: `SELECT $__timeInterval(occurred_at) AS time, host_id, max(${json(k)}) AS ${k} FROM ${EVENTS(['host.sample'], undefined, true)} GROUP BY time, host_id ORDER BY time`,
    })),
  },
  {
    uid: 'calvin-traces',
    title: 'Calvin · Trace explorer',
    variables: ['trace_id', 'session_key'],
    panels: [
      { title: 'Trace waterfall', type: 'table', width: 24, sql: WATERFALL, bar: 'end_ms' },
      {
        title: 'Trace gantt (needs the marcusolsson-gantt-panel plugin)',
        type: 'marcusolsson-gantt-panel',
        width: 24,
        sql: WATERFALL,
        options: { textField: 'name', startField: 'started_at', endField: 'ended_at' },
      },
      {
        title: 'Turns in session',
        type: 'table',
        width: 24,
        links: { trace_id: TRACE_LINK },
        sql: `SELECT sent_at, trace_id, path, outcome, first_visible_ms, overhead_ms, ttft_ms, max_silence_ms
FROM turns WHERE session_key = '\${session_key}' ORDER BY sent_at LIMIT 1 BY turn_id`,
      },
    ],
  },
];

export { KPI };
