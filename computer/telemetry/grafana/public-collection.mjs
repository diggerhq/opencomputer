// Public counterparts of the operational dashboards. Every query returns
// aggregate measurements or anonymized machine labels; no individual traces.
import { publicPanel } from './public-latency.mjs';

const TURN_FILTER = "$__timeFilter(sent_at) AND NOT synthetic AND surface = 'slack'";
const TURNS = `(SELECT * FROM turns WHERE ${TURN_FILTER} LIMIT 1 BY turn_id)`;
const TIME = 'toStartOfInterval(sent_at, INTERVAL 6 HOUR)';
const EVENT_TIME = 'toStartOfInterval(occurred_at, INTERVAL 6 HOUR)';
const EVENTS = (names) => `(SELECT * FROM calvin_events WHERE $__timeFilter(occurred_at) AND event_name IN (${names.map((n) => `'${n}'`).join(', ')}) LIMIT 1 BY event_id)`;
const percentile = (column) => `if(count(${column}) >= 20, quantile(0.95)(${column}), NULL)`;
const turnSeries = (column) => `SELECT ${TIME} AS time, quantile(0.5)(${column}) AS median, ${percentile(column)} AS p95 FROM ${TURNS} WHERE ${column} IS NOT NULL GROUP BY time ORDER BY time`;
const eventSeries = (names, column = 'duration_ms') => `SELECT ${EVENT_TIME} AS time, quantile(0.5)(${column}) AS median, ${percentile(column)} AS p95 FROM ${EVENTS(names)} WHERE ${column} IS NOT NULL GROUP BY time ORDER BY time`;
const num = (key) => `JSONExtractFloat(data, '${key}')`;

function dashboard(slug, title, descriptions, panels) {
  return {
    uid: `opencomputer-public-${slug}`, title: `OpenComputer · ${title}`, schemaVersion: 39,
    tags: ['opencomputer', 'public'], timezone: 'utc', editable: false,
    time: { from: 'now-7d', to: 'now' }, refresh: '30s',
    timepicker: { refresh_intervals: ['30s', '1m', '5m', '15m'] },
    templating: { list: [] }, annotations: { list: [] }, links: [],
    panels: [
      { id: 1, type: 'text', title: title, gridPos: { x: 0, y: 0, w: 24, h: 4 }, options: { mode: 'markdown', content: descriptions } },
      ...panels.map((p, i) => publicPanel(i + 2, p.title, p.sql, (i % 2) * 12, 4 + Math.floor(i / 2) * 8, p)),
    ],
  };
}

export function publicCollection() {
  const note = 'Live aggregate metrics; refreshes every 30 seconds. Times are UTC. Latency charts use six-hour buckets and show p95 only with 20+ measurements. Current buckets are partial; gaps mean insufficient data. Traffic and model mix can change.';
  return [
    dashboard('speed', 'Speed', `${note}\n\nSlack turns across reporting machines. First visible output can include the opening status message; first content excludes that placeholder but can include progress updates.`, [
      { title: 'First visible output', sql: turnSeries('first_visible_ms') },
      { title: 'First content', sql: turnSeries('first_content_ms') },
      { title: 'Platform overhead', sql: turnSeries('overhead_ms') },
      { title: 'Model first-token wait', sql: turnSeries('ttft_ms') },
      { title: 'Longest silence between visible updates', sql: turnSeries('max_silence_ms') },
      { title: 'Acknowledgement latency', sql: eventSeries(['ack.done']) },
    ]),
    dashboard('cold-path', 'Cold path', `${note}\n\nStartup stages are averages per six-hour bucket. Compare startup paths separately; their traffic volumes differ.`, [
      ...['new', 'resume', 'prewarmed'].map((path) => ({ title: `Startup stages · ${path}`, sql: `SELECT ${TIME} AS time, avg(fork_ms) AS workspace, avg(launch_ms) AS launch, avg(harness_init_ms) AS harness, avg(intro_ms) AS intro, avg(names_ms) AS names, avg(ttft_ms) AS model_wait FROM ${TURNS} WHERE path = '${path}' GROUP BY time ORDER BY time` })),
      { title: 'Repository setup duration · fleet', sql: eventSeries(['fork.repo']) },
      { title: 'Name resolution', sql: eventSeries(['names.resolved']) },
      { title: 'Credential minting', sql: eventSeries(['token.minted']) },
    ]),
    dashboard('models', 'Models and harnesses', `${note}\n\nSlack model waits are runner-recorded timings; they are affected by harness startup and context size. Model populations are not controlled experiments.`, [
      { title: 'Recorded model wait by model · median', sql: `SELECT ${TIME} AS time, model, quantile(0.5)(ttft_ms) AS median FROM ${TURNS} WHERE ttft_ms IS NOT NULL GROUP BY time, model ORDER BY time, model` },
      { title: 'Recorded model wait by model · p95', sql: `SELECT ${TIME} AS time, model, ${percentile('ttft_ms')} AS p95 FROM ${TURNS} WHERE ttft_ms IS NOT NULL GROUP BY time, model ORDER BY time, model` },
      { title: 'Cache hit ratio by model', unit: 'percentunit', sql: `SELECT ${TIME} AS time, model, sum(cache_read_tokens) / greatest(sum(input_tokens + cache_read_tokens + cache_creation_tokens), 1) AS ratio FROM ${TURNS} GROUP BY time, model ORDER BY time, model` },
      { title: 'Model sample counts', type: 'table', unit: 'short', sql: `SELECT harness, model, count() AS turns, count(ttft_ms) AS measured_model_waits, count(first_content_ms) AS measured_responses FROM ${TURNS} GROUP BY harness, model ORDER BY turns DESC` },
    ]),
    dashboard('reliability', 'Reliability', `${note}\n\nCounts include failures and silent turns. Frontend call events cover slow, failed or rate-limited calls; their latency distribution does not represent every frontend call.`, [
      { title: 'Slack turn outcomes', unit: 'short', sql: `SELECT ${TIME} AS time, outcome, count() AS turns FROM ${TURNS} GROUP BY time, outcome ORDER BY time, outcome` },
      { title: 'Dispatch and runner trouble', unit: 'short', sql: `SELECT ${EVENT_TIME} AS time, event_name, count() AS events FROM ${EVENTS(['queue.retried', 'queue.failed', 'dispatch.parked', 'turn.abandoned'])} GROUP BY time, event_name ORDER BY time, event_name` },
      { title: 'Frontend rate limiting and errors', unit: 'short', sql: `SELECT ${EVENT_TIME} AS time, countIf(JSONExtractBool(data, 'rate_limited')) AS rate_limited, countIf(outcome = 'failed') AS failed FROM ${EVENTS(['surface.call'])} GROUP BY time ORDER BY time` },
      { title: 'Dropped telemetry by reason', unit: 'short', sql: `SELECT ${EVENT_TIME} AS time, JSONExtractString(data, 'reason') AS reason, sum(${num('count')}) AS dropped FROM ${EVENTS(['telemetry.dropped'])} GROUP BY time, reason ORDER BY time, reason` },
    ]),
    dashboard('hosts', 'Machine health', 'Live fleet machine health, refreshed every 30 seconds, in five-minute UTC buckets. Machine labels are anonymized and stable across refreshes. These are reporting machines, not a complete inventory of expected machines. The latest bucket is partial.', [
      ...[['cpu_pct', 'CPU utilization', 'percent'], ['mem_used_mb', 'Memory used', 'decmbytes'], ['disk_free_mb', 'Free disk space', 'decmbytes'], ['busy_runners', 'Busy runners', 'short'], ['since_gateway_message_s', 'Time since gateway message', 's'], ['telemetry_spooled_bytes', 'Telemetry backlog', 'bytes']].map(([key, title, unit]) => ({
        title, unit, sql: `SELECT toStartOfInterval(occurred_at, INTERVAL 5 MINUTE) AS time, concat('machine-', substring(hex(SHA256(host_id)), 1, 8)) AS machine, max(${num(key)}) AS value FROM ${EVENTS(['host.sample'])} WHERE host_id != '' GROUP BY time, machine ORDER BY time, machine`,
      })),
    ]),
    dashboard('trace-timings', 'Trace timings', `${note}\n\nThis public counterpart shows aggregate event durations. Individual trace waterfalls, sessions and their identifiers remain in the private trace explorer. Event durations overlap and must not be summed into response time.`, [
      { title: 'Event duration summary', type: 'table', unit: 'short', sql: `SELECT event_name, service_name, count(duration_ms) AS measurements, round(quantile(0.5)(duration_ms)) AS median_ms, if(count(duration_ms) >= 20, round(quantile(0.95)(duration_ms)), NULL) AS p95_ms FROM ${EVENTS(['runner.launched', 'fork.done', 'fork.repo', 'harness.started', 'tool.completed', 'model.request', 'sessionlog.append', 'api.write'])} WHERE duration_ms IS NOT NULL GROUP BY event_name, service_name ORDER BY measurements DESC` },
      { title: 'Event duration by stage · p95', sql: `SELECT ${EVENT_TIME} AS time, event_name, ${percentile('duration_ms')} AS p95 FROM ${EVENTS(['runner.launched', 'fork.done', 'tool.completed', 'model.request', 'sessionlog.append', 'api.write'])} WHERE duration_ms IS NOT NULL GROUP BY time, event_name ORDER BY time, event_name` },
    ]),
    dashboard('computer-api', 'Computer API', `${note}\n\nFleet API and journaling measurements, without request paths, keys, sessions or customer identifiers.`, [
      { title: 'API request latency', sql: eventSeries(['httpapi.request']) },
      { title: 'API request counts by status', unit: 'short', sql: `SELECT ${EVENT_TIME} AS time, toString(JSONExtractInt(data, 'status')) AS status, count() AS requests FROM ${EVENTS(['httpapi.request'])} GROUP BY time, status ORDER BY time, status` },
      { title: 'Session log append time', sql: eventSeries(['sessionlog.append'], num('append_ms')) },
      { title: 'Journal commit time', sql: eventSeries(['mirror.ack'], num('commit_ms')) },
    ]),
  ];
}

export function addPublicNavigation(dashboard, links) {
  dashboard.links = links.map(({ title, url }) => ({ title, url, type: 'link', targetBlank: false }));
  return dashboard;
}

export function publicDirectory(links) {
  const list = links.filter((link) => link.slug !== 'directory');
  const content = `# OpenComputer dashboards\n\nLive dashboards — no login required. Refreshes every 30 seconds as telemetry arrives.\n\n${list.map(({ title, url, description }) => `- **[${title}](${url})** — ${description}`).join('\n\n')}\n\nAll views use UTC. Latency p95 needs at least 20 measurements per bucket. Public views exclude customer and individual trace identifiers; machine labels are anonymized.`;
  const result = dashboard('directory', 'Dashboard directory', content, []);
  result.panels[0].gridPos.h = 18;
  result.timepicker.hidden = true;
  return addPublicNavigation(result, links);
}
