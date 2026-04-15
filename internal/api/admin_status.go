package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

// adminStatusPage serves a self-contained HTML dashboard showing real-time
// worker status, sandbox counts, and system health. Auto-refreshes every 2s.
// Protected by API key auth (same as /api/workers).
func (s *Server) adminStatusPage(c echo.Context) error {
	apiKey := c.Request().Header.Get("X-API-Key")
	if apiKey == "" {
		apiKey = c.QueryParam("key")
	}

	return c.HTML(http.StatusOK, adminHTML)
}

const adminHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>OpenSandbox — Admin Status</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #08080c; color: #e0e0e0; font-family: 'JetBrains Mono', 'SF Mono', monospace; font-size: 13px; padding: 20px; }
  h1 { font-size: 18px; color: #818cf8; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 12px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 16px; }
  .stat .label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .stat .value { font-size: 28px; font-weight: bold; margin-top: 4px; }
  .stat .value.green { color: #34d399; }
  .stat .value.blue { color: #60a5fa; }
  .stat .value.amber { color: #fbbf24; }
  .stat .value.red { color: #f87171; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { text-align: left; color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .bar-bg { background: rgba(255,255,255,0.05); border-radius: 4px; height: 8px; width: 100px; display: inline-block; vertical-align: middle; }
  .bar-fill { height: 8px; border-radius: 4px; transition: width 0.5s; }
  .bar-fill.cpu { background: #818cf8; }
  .bar-fill.mem { background: #34d399; }
  .bar-fill.disk { background: #fbbf24; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
  .badge.ready { background: rgba(52,211,153,0.15); color: #34d399; }
  .badge.not-ready { background: rgba(248,113,113,0.15); color: #f87171; }
  .badge.leader { background: rgba(129,140,248,0.15); color: #818cf8; }
  .log { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 8px; padding: 12px; max-height: 300px; overflow-y: auto; font-size: 12px; color: #aaa; }
  .log .entry { padding: 2px 0; }
  .log .time { color: #666; }
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 14px; color: #ccc; margin-bottom: 8px; }
  #status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .connected { background: #34d399; }
  .disconnected { background: #f87171; }
</style>
</head>
<body>
<h1>OpenSandbox Admin Status</h1>
<div class="subtitle"><span id="status-dot" class="connected"></span><span id="connection">Connected</span> — refreshing every 2s</div>

<div class="grid" id="stats"></div>

<div class="section">
  <h2>Workers</h2>
  <table>
    <thead><tr><th>Worker</th><th>Machine</th><th>Sandboxes</th><th>CPU</th><th>Memory</th><th>Disk</th><th>Version</th></tr></thead>
    <tbody id="workers"></tbody>
  </table>
</div>

<div class="section" style="display:flex;gap:12px;align-items:center">
  <h2>Activity Log</h2>
  <button onclick="generateReport()" style="background:rgba(129,140,248,0.15);color:#818cf8;border:1px solid rgba(129,140,248,0.3);padding:4px 12px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px">Generate Report</button>
  <button onclick="clearLog()" style="background:rgba(255,255,255,0.05);color:#888;border:1px solid rgba(255,255,255,0.1);padding:4px 12px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px">Clear</button>
</div>
<div class="log" id="log"></div>

<script>
const API_KEY = new URLSearchParams(window.location.search).get('key') || '';
const BASE = window.location.origin;
let prevWorkerCount = -1;
let prevSandboxCount = -1;

function bar(pct, cls) {
  return '<div class="bar-bg"><div class="bar-fill ' + cls + '" style="width:' + Math.min(pct, 100) + '%"></div></div> ' + pct.toFixed(0) + '%';
}

const typeColors = {
  create: '#34d399', destroy: '#f87171', scale: '#fbbf24',
  migrate: '#818cf8', error: '#f87171', scaler: '#60a5fa'
};
const typeIcons = {
  create: '+', destroy: 'x', scale: '~',
  migrate: '→', error: '!', scaler: '⚙'
};

function addLog(msg, type) {
  const log = document.getElementById('log');
  const now = new Date().toLocaleTimeString();
  const color = typeColors[type] || '#aaa';
  const icon = typeIcons[type] || '•';
  const el = document.createElement('div');
  el.className = 'entry';
  el.innerHTML = '<span class="time">' + now + '</span> ' +
    '<span style="color:' + color + ';font-weight:bold">[' + icon + ']</span> ' + msg;
  log.insertBefore(el, log.firstChild);
  while (log.children.length > 200) log.removeChild(log.lastChild);
}

async function refresh() {
  try {
    const [workersResp, readyResp] = await Promise.all([
      fetch(BASE + '/api/workers', { headers: { 'X-API-Key': API_KEY } }),
      fetch(BASE + '/readyz')
    ]);

    const workers = await workersResp.json();
    const ready = await readyResp.json();

    document.getElementById('status-dot').className = 'connected';
    document.getElementById('connection').textContent = 'Connected';

    // Use worker-reported counts (more accurate than DB query during bursts)
    const totalSandboxes = workers.reduce((s, w) => s + w.current, 0);
    const totalCapacity = workers.reduce((s, w) => s + w.capacity, 0);
    const maxCPU = workers.length ? Math.max(...workers.map(w => w.cpu_pct)) : 0;
    const maxMem = workers.length ? Math.max(...workers.map(w => w.mem_pct)) : 0;

    // Stats cards
    document.getElementById('stats').innerHTML =
      '<div class="stat"><div class="label">Workers</div><div class="value blue">' + workers.length + '</div></div>' +
      '<div class="stat"><div class="label">Sandboxes</div><div class="value green">' + totalSandboxes + '</div></div>' +
      '<div class="stat"><div class="label">Peak CPU</div><div class="value ' + (maxCPU > 80 ? 'red' : maxCPU > 50 ? 'amber' : 'green') + '">' + maxCPU.toFixed(0) + '%</div></div>' +
      '<div class="stat"><div class="label">Peak Memory</div><div class="value ' + (maxMem > 80 ? 'red' : maxMem > 50 ? 'amber' : 'green') + '">' + maxMem.toFixed(0) + '%</div></div>' +
      '<div class="stat"><div class="label">Readiness</div><div class="value"><span class="badge ' + (ready.status === 'ready' ? 'ready' : 'not-ready') + '">' + ready.status + '</span></div></div>';

    // Workers table
    const tbody = document.getElementById('workers');
    tbody.innerHTML = workers.sort((a, b) => b.current - a.current).map(w =>
      '<tr>' +
      '<td>' + w.worker_id.slice(-12) + '</td>' +
      '<td style="color:#666">' + (w.machine_id || '-').slice(-12) + '</td>' +
      '<td><strong>' + w.current + '</strong></td>' +
      '<td>' + bar(w.cpu_pct, 'cpu') + '</td>' +
      '<td>' + bar(w.mem_pct, 'mem') + '</td>' +
      '<td>' + bar(w.disk_pct, 'disk') + '</td>' +
      '<td style="color:#666">' + (w.worker_version || 'dev') + '</td>' +
      '</tr>'
    ).join('');

    // Log worker/sandbox count changes
    if (prevWorkerCount >= 0 && workers.length !== prevWorkerCount) {
      addLog(workers.length > prevWorkerCount
        ? 'Worker scaled up: ' + prevWorkerCount + ' → ' + workers.length
        : 'Worker scaled down: ' + prevWorkerCount + ' → ' + workers.length, 'scaler');
    }
    if (prevSandboxCount >= 0 && totalSandboxes !== prevSandboxCount) {
      const delta = totalSandboxes - prevSandboxCount;
      addLog((delta > 0 ? '+' : '') + delta + ' sandboxes (' + totalSandboxes + ' total)', delta > 0 ? 'create' : 'destroy');
    }
    prevWorkerCount = workers.length;
    prevSandboxCount = totalSandboxes;

  } catch (e) {
    document.getElementById('status-dot').className = 'disconnected';
    document.getElementById('connection').textContent = 'Disconnected: ' + e.message;
  }
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
}

async function generateReport() {
  try {
    const resp = await fetch(BASE + '/admin/report', { headers: { 'X-API-Key': API_KEY } });
    const r = await resp.json();

    addLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'scaler');
    addLog('<strong>REPORT</strong>', 'scaler');
    addLog('Events: ' + r.total_events + ' | Creates: ' + r.creates + ' | Destroys: ' + r.destroys, 'create');
    addLog('Scales: ' + r.scales + ' | Migrations: ' + r.migrations.total, 'scale');

    if (r.migrations.details && r.migrations.details.length > 0) {
      addLog('<strong>Migrations (' + r.migrations.total + ')</strong>:', 'migrate');
      r.migrations.details.forEach(function(m) {
        addLog(m.sandbox.slice(-8) + ' → ' + m.worker.slice(-8) + ': ' + m.detail, 'migrate');
      });
      addLog('All ' + r.migrations.total + ' migrations succeeded', 'migrate');
    } else {
      addLog('No migrations triggered', 'scale');
    }

    if (r.workers) {
      addLog('<strong>Workers:</strong>', 'scaler');
      r.workers.sort(function(a,b) { return b.current - a.current; }).forEach(function(w) {
        const bar = w.current > 0 ? '█'.repeat(Math.min(w.current, 40)) : '·';
        addLog(w.id + ' ' + bar + ' ' + w.current + ' sb  cpu=' + w.cpu_pct.toFixed(0) + '%  mem=' + w.mem_pct.toFixed(0) + '%', 'scaler');
      });
    }
    addLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'scaler');
  } catch(e) {
    addLog('Report failed: ' + e.message, 'error');
  }
}

refresh();
setInterval(refresh, 2000);

// Connect to SSE event stream for real-time events
const evtSource = new EventSource(BASE + '/admin/events');
evtSource.onmessage = function(e) {
  try {
    const evt = JSON.parse(e.data);
    let msg = evt.detail;
    if (evt.sandbox) msg = '<span style="color:#888">' + evt.sandbox.slice(-8) + '</span> ' + msg;
    addLog(msg, evt.type);
  } catch(err) {}
};
evtSource.onerror = function() {
  // Will auto-reconnect
};
</script>
</body>
</html>`
