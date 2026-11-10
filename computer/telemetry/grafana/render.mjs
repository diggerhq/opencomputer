#!/usr/bin/env node
// Renders telemetry/grafana/{dashboards/*.json, alerting/rules.json} from
// dashboards.mjs, rules.mjs and telemetry/thresholds.json (work 054). The
// JSON is committed so it can be imported or provisioned as is; CI runs
// `--check`, which fails when it is stale or a threshold exceeds its budget.
//
//   node telemetry/grafana/render.mjs           write
//   node telemetry/grafana/render.mjs --check   verify only

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computerApiDashboard } from './computer-api.mjs';
import { dashboards } from './dashboards.mjs';
import { renderRules } from './rules.mjs';

const HERE = import.meta.dirname;
const { thresholds, computer_api: api = [] } = JSON.parse(readFileSync(path.join(HERE, '../thresholds.json'), 'utf8'));
// biome-ignore lint/suspicious/noTemplateCurlyInString: the Grafana `$datasource` variable
const DS = { type: 'grafana-clickhouse-datasource', uid: '${datasource}' };

const problems = [];
for (const t of thresholds) if (!(t.threshold_ms <= t.budget_ms)) problems.push(`${t.kpi} ${t.path}: threshold_ms ${t.threshold_ms} exceeds budget_ms ${t.budget_ms}`);
for (const t of api) if (!(t.threshold <= t.budget)) problems.push(`computer_api ${t.id}: threshold ${t.threshold} exceeds budget ${t.budget}`);

const target = (sql, table) => ({ refId: 'A', datasource: DS, editorType: 'sql', format: table ? 1 : 0, queryType: table ? 'table' : 'timeseries', rawSql: sql });

function panel(p, i, x, y) {
  const w = p.width ?? 12;
  const table = p.type === 'table' || p.type === 'marcusolsson-gantt-panel';
  const out = { id: i + 1, type: p.type ?? 'timeseries', title: p.title, datasource: DS, gridPos: { h: table ? 10 : 8, w, x, y }, targets: [target(p.sql, table)] };
  const defaults = { unit: p.unit ?? 'short' };
  if (!table) {
    defaults.custom = { drawStyle: 'line', lineWidth: 2, fillOpacity: p.stack ? 40 : 0, stacking: { mode: p.stack ? 'normal' : 'none' } };
    if (p.threshold !== undefined) {
      defaults.custom.thresholdsStyle = { mode: 'line+area' };
      defaults.thresholds = { mode: 'absolute', steps: [{ color: 'transparent', value: null }, { color: 'red', value: p.threshold }] };
    }
  }
  const overrides = Object.entries(p.links ?? {}).map(([field, url]) => ({
    matcher: { id: 'byName', options: field },
    properties: [{ id: 'links', value: [{ title: 'Open trace', url }] }],
  }));
  if (p.bar) overrides.push({ matcher: { id: 'byName', options: p.bar }, properties: [{ id: 'custom.cellOptions', value: { type: 'gauge', mode: 'basic' } }] });
  out.fieldConfig = { defaults, overrides };
  if (p.options) out.options = p.options;
  if (p.description) out.description = p.description;
  return out;
}

function dashboard(d) {
  let x = 0;
  let y = 0;
  const panels = d.panels.map((p, i) => {
    if (p.row) {
      // A row header (work 084): starts a new line, the panels after it sit below.
      if (x > 0) (x = 0), (y += 10);
      const out = { id: i + 1, type: 'row', title: p.row, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] };
      y += 1;
      return out;
    }
    const w = p.width ?? 12;
    if (x + w > 24) (x = 0), (y += 10);
    const out = panel(p, i, x, y);
    x += w;
    return out;
  });
  const variables = [
    { type: 'datasource', name: 'datasource', label: 'Tinybird', query: 'grafana-clickhouse-datasource', current: {} },
    ...(d.variables ?? []).map((name) => ({ type: 'textbox', name, label: name, query: '' })),
  ];
  return {
    uid: d.uid,
    title: d.title,
    tags: ['calvin', 'telemetry'],
    timezone: 'utc',
    schemaVersion: 39,
    time: { from: 'now-24h', to: 'now' },
    refresh: '5m',
    templating: { list: variables },
    annotations: {
      list: (d.annotations ?? []).map((a) => ({ name: a.name, enable: true, iconColor: 'blue', datasource: DS, target: target(a.sql, true) })),
    },
    links: [{ title: 'Calvin', type: 'dashboards', tags: ['calvin'], asDropdown: true }],
    panels,
  };
}

const files = new Map();
for (const d of [...dashboards(thresholds), ...(api.length ? [computerApiDashboard(api)] : [])]) files.set(`dashboards/${d.uid.replace('calvin-', '')}.json`, dashboard(d));
const rules = renderRules(thresholds, api);
files.set('alerting/rules.json', rules);
const uids = new Set(rules.groups.flatMap((g) => g.rules.map((r) => r.uid)));
for (const t of api)
  if (t.kind === 'alert' && !uids.has(`calvin-api-${t.id.replaceAll('_', '-')}`)) problems.push(`computer_api ${t.id}: an alert row with no rule in computer-api.mjs`);

const check = process.argv.includes('--check');
for (const [rel, doc] of files) {
  const file = path.join(HERE, rel);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (check) {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {}
    if (current !== text) problems.push(`${rel} is stale: run node telemetry/grafana/render.mjs`);
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
for (const p of problems) console.error(`FAIL ${p}`);
if (!problems.length) console.log(`grafana ${check ? 'ok' : 'written'}: ${files.size} files from ${thresholds.length + api.length} thresholds`);
process.exit(problems.length ? 1 : 0);
