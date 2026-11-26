// A public, aggregate-only dashboard. Use a fixed datasource and no variables:
// externally shared dashboards execute saved queries without exposing Explore.
// Never add host, customer, person, conversation, session or trace identifiers.
import { DATASOURCE_UID } from './rules.mjs';

const DS = { type: 'grafana-clickhouse-datasource', uid: DATASOURCE_UID };
const FILTER = "$__timeFilter(sent_at) AND surface = 'slack' AND outcome = 'completed' AND NOT synthetic";
const TURNS = `(SELECT * FROM turns WHERE ${FILTER} LIMIT 1 BY turn_id)`;
const BUCKET = 'toStartOfInterval(sent_at, INTERVAL 6 HOUR)';

function target(sql, table = false) {
  return { refId: 'A', datasource: DS, editorType: 'sql', format: table ? 1 : 0, queryType: table ? 'table' : 'timeseries', rawSql: sql };
}

function series(column) {
  return `SELECT ${BUCKET} AS time,
  if(count(${column}) > 0, quantile(0.5)(${column}), NULL) AS median,
  if(count(${column}) >= 20, quantile(0.95)(${column}), NULL) AS p95
FROM ${TURNS} GROUP BY time ORDER BY time`;
}

export function publicPanel(id, title, sql, x, y, { type = 'timeseries', unit = 'ms', w = 12, h = 8, description = '' } = {}) {
  const defaults = { unit, decimals: unit === 'ms' ? 2 : unit === 'short' ? 0 : 1, noValue: 'No data' };
  if (type === 'timeseries') defaults.custom = { drawStyle: 'line', lineWidth: 2, fillOpacity: 8, spanNulls: false, showPoints: 'always' };
  return {
    id, title, description, type, datasource: DS, gridPos: { x, y, w, h }, targets: [target(sql, type !== 'timeseries')],
    fieldConfig: { defaults, overrides: [] },
    options: type === 'stat'
      ? { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'none', graphMode: 'none', textMode: 'auto' }
      : { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi', sort: 'desc' } },
  };
}

const panel = publicPanel;

export function publicLatencyDashboard() {
  const percentileDescription = 'Completed Slack turns across reporting machines, in six-hour UTC buckets. Median needs one measurement; p95 needs at least 20. Gaps mean insufficient measurements. The latest bucket is partial.';
  return {
    uid: 'opencomputer-public-latency',
    title: 'OpenComputer · Live response latency',
    description: 'Aggregate response latency across reporting machines. Customer, machine and trace identities are excluded.',
    tags: ['opencomputer', 'latency', 'public'],
    timezone: 'utc', schemaVersion: 39, editable: false,
    time: { from: 'now-7d', to: 'now' }, refresh: '30s',
    timepicker: { refresh_intervals: ['30s', '1m', '5m', '15m'] },
    templating: { list: [] }, annotations: { list: [] }, links: [],
    panels: [
      {
        id: 1, type: 'text', title: 'How to read this dashboard', gridPos: { x: 0, y: 0, w: 24, h: 4 },
        options: { mode: 'markdown', content: 'Live, aggregate Slack response timings across reporting machines. **First content** excludes the opening “Started” placeholder, but can include a thinking/progress update. It is not time to a finished answer. Refreshes every 30 seconds as telemetry arrives.\n\nCharts use six-hour UTC buckets; p95 appears only with **20+ measurements**. The current bucket and current day are partial. Missing measurements are shown in coverage, not counted as zero latency. Traffic and model mix can change.' },
      },
      panel(2, 'First content · median', `SELECT if(count(first_content_ms) > 0, quantile(0.5)(first_content_ms), NULL) AS value FROM ${TURNS}`, 0, 4, { type: 'stat', w: 6, h: 4 }),
      panel(3, 'First content · p95', `SELECT if(count(first_content_ms) >= 20, quantile(0.95)(first_content_ms), NULL) AS value FROM ${TURNS}`, 6, 4, { type: 'stat', w: 6, h: 4, description: 'Selected time range; at least 20 measured turns.' }),
      panel(4, 'Measured responses', `SELECT count(first_content_ms) AS value FROM ${TURNS}`, 12, 4, { type: 'stat', unit: 'short', w: 6, h: 4 }),
      panel(5, 'Response timing coverage', `SELECT if(count() > 0, count(first_content_ms) / count(), NULL) AS value FROM ${TURNS}`, 18, 4, { type: 'stat', unit: 'percentunit', w: 6, h: 4, description: 'Completed Slack turns with a first-content timestamp / all completed Slack turns. Silent, failed and incomplete turns are excluded.' }),
      panel(6, 'First content · median and p95', series('first_content_ms'), 0, 8, { description: percentileDescription }),
      panel(7, 'Recorded model first-token wait · median and p95', series('ttft_ms'), 12, 8, { description: `${percentileDescription} This is the runner-recorded initial model wait; harness startup and model differences affect it.` }),
      panel(8, 'Platform overhead · median and p95', series('overhead_ms'), 0, 16, { description: `${percentileDescription} Derived startup and output-delivery overhead; not the entire response time.` }),
      panel(9, 'First content by startup path · median', `SELECT ${BUCKET} AS time, path,
  quantile(0.5)(first_content_ms) AS median
FROM ${TURNS} WHERE first_content_ms IS NOT NULL AND path IN ('warm', 'new', 'prewarmed', 'resume')
GROUP BY time, path ORDER BY time, path`, 12, 16, { description: 'Six-hour buckets, split by startup path to help distinguish traffic-mix changes. Each point needs at least one measurement; small samples can vary widely.' }),
      panel(10, 'Response timing coverage over time', `SELECT ${BUCKET} AS time,
  count(first_content_ms) / count() AS coverage
FROM ${TURNS} GROUP BY time ORDER BY time`, 0, 24, { unit: 'percentunit', description: 'Coverage of first-content measurements among completed Slack turns. This does not measure coverage of the full machine inventory.' }),
      panel(11, 'Machines reporting health', `SELECT toStartOfInterval(occurred_at, INTERVAL 5 MINUTE) AS time,
  uniqExact(host_id) AS machines
FROM calvin_events WHERE $__timeFilter(occurred_at) AND event_name = 'host.sample' AND host_id != ''
GROUP BY time ORDER BY time`, 12, 24, { unit: 'short', description: 'Distinct machines sending health samples in each five-minute bucket. This is a reporting count, not the number of machines expected to be online. The current bucket is partial.' }),
      panel(12, 'Daily response summary · UTC', `SELECT toStartOfDay(sent_at) AS day,
  count() AS completed_turns, count(first_content_ms) AS measured_turns,
  if(count(first_content_ms) > 0, round(quantile(0.5)(first_content_ms)), NULL) AS median_ms,
  if(count(first_content_ms) >= 20, round(quantile(0.95)(first_content_ms)), NULL) AS p95_ms
FROM ${TURNS} GROUP BY day ORDER BY day`, 0, 32, { type: 'table', unit: 'short', w: 24, h: 8, description: 'Milliseconds. Partial days reflect only the selected range. p95 requires 20 measurements.' }),
    ],
  };
}
