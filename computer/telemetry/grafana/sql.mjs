// The SQL behind the Grafana dashboards and alert rules (work 054,
// "Dashboards and alerts"), read through Tinybird's ClickHouse interface.
// Every query deduplicates (`LIMIT 1 BY event_id` / `turn_id`, delivery is at
// least once) and leaves synthetic canary traffic out unless it says why.

export const TURNS = (where = '$__timeFilter(sent_at)') =>
  `(SELECT * FROM turns WHERE ${where} AND NOT synthetic LIMIT 1 BY turn_id)`;
export const EVENTS = (names, where = '$__timeFilter(occurred_at)', synthetic = false) =>
  `(SELECT * FROM calvin_events WHERE ${where} AND event_name IN (${names.map((n) => `'${n}'`).join(', ')})${
    synthetic ? '' : ' AND NOT synthetic'
  } LIMIT 1 BY event_id)`;
export const VISIBLE = "outcome != 'silent'";

/** Per KPI: the column, its source and the turns it counts. K1 comes from events, K6 from the `steers` pipe, the rest from `turns`; K7 and K8 are ratios (rules.mjs). */
export const KPI = {
  K1: { title: 'Time to acknowledgement', events: ['ack.done'], col: 'duration_ms', cond: '1' },
  K2: { title: 'Time to first visible output', col: 'first_visible_ms', cond: VISIBLE },
  K3: { title: 'Calvin overhead', col: 'overhead_ms', cond: VISIBLE },
  K4: { title: 'Model time to first token', col: 'ttft_ms', cond: '1' },
  K5: { title: 'Longest silence', col: 'max_silence_ms', cond: `${VISIBLE} AND first_visible_ms IS NOT NULL` },
  K6: { title: 'Steer latency', table: 'steers', col: 'latency_ms', cond: '1' },
};

/** A KPI's rows: events, a derived pipe keyed by `occurred_at`, or turns keyed by `sent_at`. */
const timeOf = (k) => (k.events || k.table ? 'occurred_at' : 'sent_at');
const sourceOf = (k, where = `$__timeFilter(${timeOf(k)})`) =>
  k.events ? EVENTS(k.events, where) : k.table ? `(SELECT * FROM ${k.table} WHERE ${where} AND NOT synthetic)` : TURNS(where);

/** p95 of a KPI over the trailing window, 0 below the minimum sample count, for an alert rule. */
export function kpiRuleSql(t) {
  const k = KPI[t.kpi];
  const where = `${timeOf(k)} > now() - INTERVAL ${t.window_h} HOUR`;
  const filters = [t.path !== '*' ? `path = '${t.path}'` : '', t.harness !== '*' ? `harness = '${t.harness}'` : '', k.cond]
    .filter(Boolean)
    .join(' AND ');
  const src = sourceOf(k, where);
  return `SELECT if(countIf(${k.col} IS NOT NULL AND ${filters}) >= ${t.min_n}, quantileIf(0.95)(${k.col}, ${filters}), 0) AS value FROM ${src}`;
}

/** A per-path p95 time series for a dashboard panel. */
export const kpiSeriesSql = (kpi, paths) => {
  const k = KPI[kpi];
  if (k.events || k.table)
    return `SELECT $__timeInterval(occurred_at) AS time, quantile(0.95)(${k.col}) AS p95, count() AS n FROM ${sourceOf(k)} GROUP BY time ORDER BY time`;
  const inPaths = paths ? ` WHERE path IN (${paths.map((p) => `'${p}'`).join(', ')})` : '';
  return `SELECT $__timeInterval(sent_at) AS time, path, quantileIf(0.95)(${k.col}, ${k.cond}) AS p95 FROM ${TURNS()}${inPaths} GROUP BY time, path ORDER BY time`;
};

/** One message's waterfall, as the `trace` endpoint computes it. */
export const WATERFALL = `WITH (SELECT min(sent_at) FROM calvin_events WHERE trace_id = '\${trace_id}') AS t0
SELECT event_name AS name, service_name AS service,
  toInt64(dateDiff('millisecond', t0, occurred_at)) - toInt64(ifNull(duration_ms, 0)) AS start_ms,
  toInt64(dateDiff('millisecond', t0, occurred_at)) AS end_ms, duration_ms, outcome, error_type, tool_name, data,
  occurred_at - toIntervalMillisecond(ifNull(duration_ms, 0)) AS started_at, occurred_at AS ended_at
FROM (SELECT * FROM calvin_events WHERE trace_id = '\${trace_id}' LIMIT 1 BY event_id)
ORDER BY end_ms, start_ms, name`;
