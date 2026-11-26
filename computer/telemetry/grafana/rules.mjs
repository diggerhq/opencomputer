// Grafana alert rules (work 054, "Dashboards and alerts"), in Grafana's file
// provisioning format. KPI rules come from telemetry/thresholds.json; the
// failure, absence and pipeline rules are fixed here; the computer API rules
// (work 084) come from computer-api.mjs and thresholds.json `computer_api`.
//
// Invariants: every query returns one numeric `value` (or one per `host_id`);
// percentile rules return 0 below their minimum sample count so low volume
// never fires them; absence rules treat no data as firing and also notify by
// email (label `email: "true"`), since Slack is the product's own frontend.

import { computerApiRules } from './computer-api.mjs';
import { EVENTS, kpiRuleSql, KPI, TURNS } from './sql.mjs';

export const DATASOURCE_UID = 'calvin-tinybird';
const DASH = '/d/calvin-speed';
const TRACES = '/d/calvin-traces';

const H = (h) => h * 3600;
export function rule({ uid, title, sql, op = 'gt', value, window = H(1), forDur = '0s', noData = 'OK', email = false, summary, panel = DASH }) {
  return {
    uid,
    title,
    condition: 'C',
    data: [
      {
        refId: 'A',
        relativeTimeRange: { from: window, to: 0 },
        datasourceUid: DATASOURCE_UID,
        model: { refId: 'A', editorType: 'sql', format: 1, queryType: 'table', rawSql: sql },
      },
      { refId: 'B', datasourceUid: '__expr__', model: { refId: 'B', type: 'reduce', expression: 'A', reducer: 'last' } },
      {
        refId: 'C',
        datasourceUid: '__expr__',
        model: { refId: 'C', type: 'threshold', expression: 'B', conditions: [{ evaluator: { type: op, params: [value] } }] },
      },
    ],
    noDataState: noData,
    execErrState: 'Error',
    for: forDur,
    annotations: {
      summary,
      description: `Value {{ $values.B.Value }}. Slowest traces: ${TRACES}; runbook: work 054, "Operator runbook"`,
      __dashboardUid__: panel.replace('/d/', ''),
    },
    labels: { team: 'calvin', ...(email ? { email: 'true' } : {}) },
  };
}

const kpiRules = (thresholds) =>
  thresholds.map((t) =>
    rule({
      uid: `calvin-${t.kpi.toLowerCase()}-${t.path === '*' ? 'all' : t.path}${t.harness === '*' ? '' : `-${t.harness}`}`,
      title: `${t.kpi} ${KPI[t.kpi].title} p95${t.path === '*' ? '' : ` (${t.path})`} > ${t.threshold_ms} ms`,
      sql: kpiRuleSql(t),
      value: t.threshold_ms,
      window: H(t.window_h),
      forDur: t.for,
      summary: `${KPI[t.kpi].title} p95 over ${t.window_h} h is above ${t.threshold_ms} ms (budget ${t.budget_ms} ms, n >= ${t.min_n}).`,
    }),
  );

const recent = (minutes) => `occurred_at > now() - INTERVAL ${minutes} MINUTE`;

const fixedRules = () => [
  rule({
    uid: 'calvin-k7-failures',
    title: 'K7 turn failures > 1%',
    sql: `SELECT if(t.n + a.n >= 20, (t.failed + a.n) / (t.n + a.n), 0) AS value FROM
  (SELECT count() AS n, countIf(outcome = 'failed') AS failed FROM ${TURNS('sent_at > now() - INTERVAL 1 HOUR')}) AS t,
  (SELECT count() AS n FROM ${EVENTS(['turn.abandoned'], recent(60))}) AS a`,
    value: 0.01,
    forDur: '1h',
    summary: 'More than 1% of turns failed or were abandoned in the last hour.',
  }),
  rule({
    uid: 'calvin-k7-lost',
    title: 'K7 a queued job failed or a turn was abandoned',
    sql: `SELECT count() AS value FROM ${EVENTS(['queue.failed', 'turn.abandoned'], recent(15))}`,
    value: 0,
    window: 900,
    summary: 'A gateway job gave up, or a runner died mid-turn (turn.abandoned).',
  }),
  rule({
    uid: 'calvin-no-host',
    title: 'Dispatch parked with no host',
    sql: `SELECT count() AS value FROM (
  SELECT dispatch_id, maxIf(occurred_at, event_name = 'dispatch.parked') AS parked, maxIf(occurred_at, event_name = 'dispatch.sent') AS sent
  FROM ${EVENTS(['dispatch.parked', 'dispatch.sent'], recent(15), true)} GROUP BY dispatch_id)
WHERE parked > toDateTime64(0, 3) AND sent < parked AND parked < now() - INTERVAL 60 SECOND`,
    value: 0,
    window: 900,
    summary: 'A message is waiting for a host that is not connected (dispatch.parked without a later dispatch.sent within 60 s).',
  }),
  rule({
    uid: 'calvin-k8-rate-limited',
    title: 'K8 frontend rate limiting',
    sql: `SELECT countIf(JSONExtractBool(data, 'rate_limited')) AS value FROM ${EVENTS(['surface.call'], recent(5), true)}`,
    value: 0,
    window: 300,
    forDur: '5m',
    summary: 'The frontend API (Slack) is rate-limiting Calvin.',
  }),
  rule({
    uid: 'calvin-k8-errors',
    title: 'K8 frontend API errors > 1%',
    sql: `SELECT if(sum(surface_calls) >= 100, sum(surface_errors) / sum(surface_calls), 0) AS value FROM ${TURNS('sent_at > now() - INTERVAL 1 HOUR')}`,
    value: 0.01,
    forDur: '30m',
    summary: 'More than 1% of frontend API calls failed in the last hour.',
  }),
  rule({
    uid: 'calvin-canary-missing',
    title: 'Canary: no completed synthetic turn in 25 min',
    sql: `SELECT count() AS value FROM ${EVENTS(['turn.ended'], recent(25), true)} WHERE synthetic AND outcome = 'completed'`,
    op: 'lt',
    value: 1,
    window: 1500,
    noData: 'Alerting',
    email: true,
    summary: 'The canary has not completed a turn in 25 minutes: Calvin, or the telemetry pipeline, is down.',
  }),
  rule({
    uid: 'calvin-canary-failing',
    title: 'Canary: two synthetic failures in a row',
    sql: `SELECT countIf(outcome = 'failed') AS value FROM (SELECT outcome FROM turns WHERE synthetic AND sent_at > now() - INTERVAL 1 HOUR ORDER BY sent_at DESC LIMIT 1 BY turn_id LIMIT 2)`,
    value: 1,
    email: true,
    summary: 'The last two canary turns failed.',
  }),
  rule({
    uid: 'calvin-telemetry-drops',
    title: 'Telemetry loss > 1% of events',
    sql: `SELECT if(count() >= 100, sumIf(JSONExtractUInt(data, 'count'), event_name = 'telemetry.dropped' AND JSONExtractString(data, 'reason') != 'duplicate_delivery') / count(), 0) AS value
FROM (SELECT * FROM calvin_events WHERE ${recent(60)} LIMIT 1 BY event_id)`,
    value: 0.01,
    forDur: '15m',
    summary: 'Emitters, hosts or the collector dropped more than 1% of telemetry in the last hour (see telemetry.dropped by reason).',
    panel: '/d/calvin-reliability',
  }),
  rule({
    uid: 'calvin-telemetry-gaps',
    title: 'Telemetry: host batches missing',
    sql: `SELECT sum(missing) AS value FROM (
  SELECT host_id, JSONExtractString(data, 'host_boot_id') AS boot, max(JSONExtractUInt(data, 'batch_seq')) - min(JSONExtractUInt(data, 'batch_seq')) + 1 - uniqExact(JSONExtractUInt(data, 'batch_seq')) AS missing
  FROM ${EVENTS(['telemetry.batch'], recent(60), true)} GROUP BY host_id, boot)`,
    value: 0,
    forDur: '15m',
    summary: "A host's batch sequence has gaps: batches were lost between the host and Tinybird.",
    panel: '/d/calvin-reliability',
  }),
  rule({
    uid: 'calvin-telemetry-dark-dispatch',
    title: 'Telemetry: dispatches with no runner events',
    sql: `SELECT count() AS value FROM (
  SELECT trace_id FROM ${EVENTS(['dispatch.sent'], 'occurred_at BETWEEN now() - INTERVAL 60 MINUTE AND now() - INTERVAL 5 MINUTE', true)}
  WHERE trace_id NOT IN (SELECT trace_id FROM calvin_events WHERE ${recent(70)} AND service_name = 'runner'))`,
    value: 0,
    forDur: '15m',
    summary: 'Messages reached a host (dispatch.sent) but no runner telemetry arrived for them.',
    panel: '/d/calvin-reliability',
  }),
  rule({
    uid: 'calvin-host-silent',
    title: 'Host silent',
    sql: `SELECT host_id, dateDiff('second', max(occurred_at), now()) AS value FROM calvin_events
WHERE event_name = 'host.sample' AND occurred_at > now() - INTERVAL 1 DAY GROUP BY host_id`,
    value: 300,
    window: H(24),
    noData: 'Alerting',
    email: true,
    summary: 'A host seen in the last day has sent no host.sample for 5 minutes ({{ $labels.host_id }}).',
    panel: '/d/calvin-hosts',
  }),
  rule({
    uid: 'calvin-gateway-down',
    title: 'Gateway down',
    sql: `SELECT if(countIf(service_name = 'gateway') = 0 AND (countIf(event_name = 'host.sample' AND NOT JSONExtractBool(data, 'gateway_connected')) > 0
  OR maxIf(JSONExtractFloat(data, 'since_gateway_message_s'), event_name = 'host.sample') > 300), 1, 0) AS value
FROM calvin_events WHERE ${recent(5)}`,
    value: 0,
    window: 300,
    noData: 'Alerting',
    email: true,
    summary: 'No gateway events for 5 minutes while hosts report the gateway connection down or stale.',
    panel: '/d/calvin-hosts',
  }),
  rule({
    uid: 'calvin-pipeline-silent',
    title: 'Telemetry pipeline silent',
    sql: `SELECT count() AS value FROM calvin_events WHERE ${recent(10)}`,
    op: 'lt',
    value: 1,
    window: 600,
    noData: 'Alerting',
    email: true,
    summary: 'No telemetry rows at all for 10 minutes: the collector, Tinybird ingestion or every emitter is down.',
    panel: '/d/calvin-reliability',
  }),
  ...['runner_version', 'gateway_version'].map((v) =>
    rule({
      uid: `calvin-deploy-regression-${v.split('_')[0]}`,
      title: `Deploy regression: K3 on the newest ${v} > 1.3x the previous`,
      // Synthetic turns included for volume; versions ordered by first appearance, since idle runners keep old code for hours.
      sql: `SELECT if(count() = 2 AND argMax(n, first_seen) >= 30, argMax(p95, first_seen) / greatest(argMin(p95, first_seen), 1), 0) AS value FROM (
  SELECT ${v} AS version, min(sent_at) AS first_seen, count() AS n, quantile(0.95)(overhead_ms) AS p95
  FROM (SELECT * FROM turns WHERE sent_at > now() - INTERVAL 14 DAY AND outcome != 'silent' LIMIT 1 BY turn_id)
  GROUP BY version ORDER BY first_seen DESC LIMIT 2)`,
      value: 1.3,
      window: H(24 * 14),
      summary: `Calvin overhead p95 on the newest ${v} is more than 1.3x the previous version's.`,
    }),
  ),
];

/** The provisioning document: one folder, groups by evaluation interval. */
export function renderRules(thresholds, api = []) {
  const group = (name, interval, rules) => ({ orgId: 1, name, folder: 'Calvin', interval, rules });
  const fixed = fixedRules();
  const fast = new Set(['calvin-no-host', 'calvin-k8-rate-limited', 'calvin-host-silent', 'calvin-gateway-down', 'calvin-pipeline-silent', 'calvin-k7-lost']);
  return {
    apiVersion: 1,
    groups: [
      group('calvin-kpis', '5m', [...kpiRules(thresholds), ...fixed.filter((r) => !fast.has(r.uid) && !r.uid.startsWith('calvin-canary'))]),
      group('calvin-absence', '1m', [...fixed.filter((r) => fast.has(r.uid) || r.uid.startsWith('calvin-canary'))]),
      ...(api.length ? [group('calvin-computer-api', '5m', computerApiRules(api, rule))] : []),
    ],
  };
}
