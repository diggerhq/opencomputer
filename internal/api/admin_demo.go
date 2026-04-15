package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

func (s *Server) demoPingPongPage(c echo.Context) error {
	return c.HTML(http.StatusOK, demoPingPongHTML)
}

func (s *Server) demoChaosPage(c echo.Context) error {
	return c.HTML(http.StatusOK, demoChaosHTML)
}

const demoPingPongHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Live Migration Demo</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#08080c; color:#e0e0e0; font-family:'JetBrains Mono','SF Mono',monospace; font-size:13px; overflow:hidden; height:100vh; display:flex; flex-direction:column; }
  .header { padding:20px 30px 10px; }
  .header h1 { font-size:22px; color:#818cf8; }
  .header .sub { color:#666; font-size:12px; margin-top:4px; }
  .main { flex:1; display:flex; padding:0 30px 20px; gap:20px; min-height:0; }
  .left { flex:2; display:flex; flex-direction:column; gap:12px; }
  .right { flex:1; display:flex; flex-direction:column; gap:12px; }

  .card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:16px; }
  .card h2 { font-size:13px; color:#888; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; }

  .sandbox-info { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
  .info-item { text-align:center; }
  .info-item .label { font-size:10px; color:#666; text-transform:uppercase; }
  .info-item .val { font-size:20px; font-weight:bold; margin-top:2px; }
  .info-item .val.purple { color:#818cf8; }
  .info-item .val.green { color:#34d399; }
  .info-item .val.blue { color:#60a5fa; }
  .info-item .val.amber { color:#fbbf24; }

  .workers-grid { display:flex; flex-wrap:wrap; gap:8px; }
  .worker-node { width:110px; height:70px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); display:flex; flex-direction:column; align-items:center; justify-content:center; transition:all 0.5s; position:relative; }
  .worker-node .name { font-size:10px; color:#888; }
  .worker-node .status { font-size:11px; margin-top:4px; color:#555; }
  .worker-node.active { border-color:#818cf8; background:rgba(129,140,248,0.1); box-shadow:0 0 20px rgba(129,140,248,0.2); }
  .worker-node.active .name { color:#818cf8; font-weight:bold; }
  .worker-node.active .status { color:#34d399; }
  .worker-node.migrating-from { border-color:#f87171; background:rgba(248,113,113,0.1); animation:pulseRed 1s infinite; }
  .worker-node.migrating-to { border-color:#34d399; background:rgba(52,211,153,0.1); animation:pulseGreen 1s infinite; }
  @keyframes pulseRed { 0%,100% { box-shadow:0 0 10px rgba(248,113,113,0.2); } 50% { box-shadow:0 0 25px rgba(248,113,113,0.4); } }
  @keyframes pulseGreen { 0%,100% { box-shadow:0 0 10px rgba(52,211,153,0.2); } 50% { box-shadow:0 0 25px rgba(52,211,153,0.4); } }

  .migration-trail { flex:1; overflow-y:auto; min-height:0; }
  .trail-entry { display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.03); animation:fadeIn 0.3s; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(-5px); } to { opacity:1; transform:translateY(0); } }
  .trail-num { color:#555; width:24px; text-align:right; font-size:11px; }
  .trail-arrow { color:#818cf8; }
  .trail-time { color:#fbbf24; font-size:11px; }
  .trail-checks { display:flex; gap:4px; font-size:10px; }
  .trail-checks .ok { color:#34d399; }
  .trail-checks .fail { color:#f87171; }

  .verifications { display:flex; flex-wrap:wrap; gap:6px; }
  .verify-badge { padding:3px 8px; border-radius:4px; font-size:10px; }
  .verify-badge.pass { background:rgba(52,211,153,0.15); color:#34d399; }
  .verify-badge.fail { background:rgba(248,113,113,0.15); color:#f87171; }
  .verify-badge.pending { background:rgba(255,255,255,0.05); color:#555; }

  .counter { text-align:center; padding:20px; }
  .counter .big { font-size:48px; font-weight:bold; color:#818cf8; }
  .counter .of { font-size:16px; color:#555; }
  .counter .label { font-size:11px; color:#666; margin-top:4px; }
</style>
</head>
<body>
<div class="header">
  <h1>Live Migration Ping-Pong</h1>
  <div class="sub">Sandbox migrating across workers with full verification at each hop</div>
</div>

<div class="main">
  <div class="left">
    <div class="card">
      <h2>Sandbox</h2>
      <div class="sandbox-info">
        <div class="info-item"><div class="label">ID</div><div class="val purple" id="sb-id">-</div></div>
        <div class="info-item"><div class="label">Memory</div><div class="val green" id="sb-mem">-</div></div>
        <div class="info-item"><div class="label">Processes</div><div class="val blue" id="sb-procs">-</div></div>
        <div class="info-item"><div class="label">Avg Migration</div><div class="val amber" id="sb-avg">-</div></div>
      </div>
    </div>

    <div class="card">
      <h2>Workers</h2>
      <div class="workers-grid" id="workers"></div>
    </div>

    <div class="card" style="flex:1;display:flex;flex-direction:column;min-height:0">
      <h2>Migration Trail</h2>
      <div class="migration-trail" id="trail"></div>
    </div>
  </div>

  <div class="right">
    <div class="card counter">
      <div class="big" id="pass-count">0</div>
      <div class="of">/ <span id="total-count">0</span></div>
      <div class="label">Successful Migrations</div>
    </div>

    <div class="card">
      <h2>Current Verification</h2>
      <div class="verifications" id="checks">
        <span class="verify-badge pending">exec</span>
        <span class="verify-badge pending">data</span>
        <span class="verify-badge pending">hash</span>
        <span class="verify-badge pending">memory</span>
        <span class="verify-badge pending">processes</span>
        <span class="verify-badge pending">worker</span>
      </div>
    </div>

    <div class="card" style="flex:1;overflow-y:auto">
      <h2>Event Log</h2>
      <div id="log" style="font-size:11px;color:#888;"></div>
    </div>
  </div>
</div>

<script>
const API_KEY = new URLSearchParams(window.location.search).get('key') || '';
const BASE = window.location.origin;
let workers = {};
let currentWorker = '';
let passCount = 0;
let totalCount = 0;
let totalMs = 0;

function addLog(msg, color) {
  const log = document.getElementById('log');
  const el = document.createElement('div');
  el.style.padding = '2px 0';
  el.style.color = color || '#888';
  el.innerHTML = new Date().toLocaleTimeString() + ' ' + msg;
  log.insertBefore(el, log.firstChild);
}

function addTrail(num, from, to, durationMs, checks) {
  const trail = document.getElementById('trail');
  const el = document.createElement('div');
  el.className = 'trail-entry';
  const checksHtml = Object.entries(checks).map(([k,v]) =>
    '<span class="' + (v ? 'ok' : 'fail') + '">' + k + (v ? '✓' : '✗') + '</span>'
  ).join(' ');
  el.innerHTML =
    '<span class="trail-num">' + num + '</span>' +
    '<span style="color:#888">' + from + '</span>' +
    '<span class="trail-arrow">→</span>' +
    '<span style="color:#ccc">' + to + '</span>' +
    '<span class="trail-time">' + durationMs + 'ms</span>' +
    '<span class="trail-checks">' + checksHtml + '</span>';
  trail.insertBefore(el, trail.firstChild);
}

async function refreshWorkers() {
  try {
    const resp = await fetch(BASE + '/api/workers', { headers: { 'X-API-Key': API_KEY } });
    const data = await resp.json();
    // Sort workers alphabetically so they stay in a fixed order
    data.sort((a,b) => a.worker_id.localeCompare(b.worker_id));
    const grid = document.getElementById('workers');
    grid.innerHTML = data.map(w => {
      const id = w.worker_id.slice(-8);
      const cls = id === currentWorker ? 'active' : '';
      return '<div class="worker-node ' + cls + '" id="w-' + id + '">' +
        '<div class="name">' + id + '</div>' +
        '<div class="status">' + (id === currentWorker ? 'ACTIVE' : w.current + ' sb') + '</div>' +
      '</div>';
    }).join('');
  } catch(e) {}
}

let sandboxId = '';
let expectedHash = '';

async function execInSandbox(cmd, args) {
  try {
    const resp = await fetch(BASE + '/api/sandboxes/' + sandboxId + '/exec/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ cmd: cmd, args: args || [], timeout: 10 })
    });
    const data = await resp.json();
    return { stdout: (data.stdout || '').trim(), exitCode: data.exitCode };
  } catch(e) { return { stdout: '', exitCode: -1 }; }
}

function setCheck(name, pass) {
  const badges = document.querySelectorAll('#checks .verify-badge');
  badges.forEach(b => {
    if (b.textContent.startsWith(name)) {
      b.className = 'verify-badge ' + (pass ? 'pass' : 'fail');
      b.textContent = name + (pass ? ' ✓' : ' ✗');
    }
  });
}

function resetChecks() {
  document.getElementById('checks').innerHTML =
    ['exec','data','hash','memory','processes','worker'].map(n =>
      '<span class="verify-badge pending">' + n + ' ⋯</span>'
    ).join('');
}

async function runVerification(fullTargetWorker) {
  resetChecks();
  const checks = {};

  const echo = await execInSandbox('echo', ['alive']);
  checks.exec = echo.stdout === 'alive';
  setCheck('exec', checks.exec);

  const data = await execInSandbox('cat', ['/workspace/data.txt']);
  checks.data = data.stdout === 'important-data-12345';
  setCheck('data', checks.data);

  const hash = await execInSandbox('md5sum', ['/workspace/random.bin']);
  const h = (hash.stdout || '').split(' ')[0];
  checks.hash = expectedHash ? h === expectedHash : h.length === 32;
  setCheck('hash', checks.hash);

  const mem = await execInSandbox('free', ['-m']);
  const memLine = (mem.stdout || '').split('\n').find(l => l.startsWith('Mem:'));
  const memMB = memLine ? parseInt(memLine.split(/\s+/)[1]) : 0;
  checks.memory = memMB > 3000;
  setCheck('memory', checks.memory);
  document.getElementById('sb-mem').textContent = memMB + 'MB';

  const ps = await execInSandbox('sh', ['-c', 'ps aux | wc -l']);
  const procs = parseInt(ps.stdout) || 0;
  checks.processes = procs > 3;
  setCheck('processes', checks.processes);
  document.getElementById('sb-procs').textContent = procs;

  try {
    const sbResp = await fetch(BASE + '/api/sandboxes/' + sandboxId, { headers: { 'X-API-Key': API_KEY } });
    const sbData = await sbResp.json();
    checks.worker = sbData.workerID === fullTargetWorker;
  } catch(e) { checks.worker = false; }
  setCheck('worker', checks.worker);

  return { checks, allPass: Object.values(checks).every(v => v) };
}

// Only process events that arrive AFTER page load (ignore history replay)
const pageLoadTime = Date.now();
let ready = false;
setTimeout(() => { ready = true; }, 2000); // ignore events for first 2s (history replay)

const evtSource = new EventSource(BASE + '/admin/events?key=' + API_KEY);
evtSource.onmessage = async function(e) {
  if (!ready) return; // skip history replay
  try {
    const evt = JSON.parse(e.data);
    if (evt.type === 'migrate' && evt.sandbox === sandboxId) {
      const to = evt.worker.slice(-8);
      const fullTarget = evt.worker;
      const ms = evt.detail.match(/(\d+)ms/);
      const duration = ms ? ms[1] : '?';
      const from = evt.detail.match(/from (\w+)/)?.[1] || '?';

      if (currentWorker) {
        const old = document.getElementById('w-' + currentWorker);
        if (old) { old.className = 'worker-node'; old.querySelector('.status').textContent = ''; }
      }
      currentWorker = to;
      const node = document.getElementById('w-' + to);
      if (node) { node.className = 'worker-node active'; node.querySelector('.status').textContent = 'ACTIVE'; }

      totalCount++;
      totalMs += parseInt(duration) || 0;
      document.getElementById('total-count').textContent = totalCount;
      addLog('Migration #' + totalCount + ' → ' + to + ' (' + duration + 'ms) verifying...', '#818cf8');

      const { checks, allPass } = await runVerification(fullTarget);
      if (allPass) passCount++;
      document.getElementById('pass-count').textContent = passCount;
      document.getElementById('sb-avg').textContent = Math.round(totalMs / totalCount) + 'ms';

      addTrail(totalCount, from, to, duration, checks);
      addLog('Verified: ' + (allPass ? 'ALL PASS ✓' : 'FAILED ✗'), allPass ? '#34d399' : '#f87171');
      refreshWorkers();

    } else if (evt.type === 'create') {
      sandboxId = evt.sandbox;
      document.getElementById('sb-id').textContent = evt.sandbox.slice(-8);
      currentWorker = evt.worker.slice(-8);
      addLog('Created ' + evt.sandbox.slice(-8) + ' on ' + currentWorker, '#34d399');
      setTimeout(async () => {
        const hash = await execInSandbox('md5sum', ['/workspace/random.bin']);
        expectedHash = (hash.stdout || '').split(' ')[0];
        if (expectedHash) addLog('Hash baseline: ' + expectedHash.slice(0,12) + '...', '#888');
      }, 5000);
      refreshWorkers();

    } else if (evt.type === 'scale') {
      const mem = evt.detail.match(/(\d+)MB/)?.[1];
      if (mem) document.getElementById('sb-mem').textContent = mem + 'MB';
      addLog('Scaled: ' + evt.detail, '#fbbf24');
    }
  } catch(err) { addLog('Error: ' + err.message, '#f87171'); }
};

refreshWorkers();
setInterval(refreshWorkers, 3000);
</script>
</body>
</html>`

const demoChaosHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>200-Sandbox Chaos Test</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#08080c; color:#e0e0e0; font-family:'JetBrains Mono','SF Mono',monospace; font-size:13px; overflow:hidden; height:100vh; display:flex; flex-direction:column; }
  .header { padding:20px 30px 10px; }
  .header h1 { font-size:22px; color:#34d399; }
  .header .sub { color:#666; font-size:12px; margin-top:4px; }
  .main { flex:1; display:flex; padding:0 30px 20px; gap:20px; min-height:0; }
  .left { flex:2; display:flex; flex-direction:column; gap:12px; }
  .right { flex:1; display:flex; flex-direction:column; gap:12px; }

  .card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:16px; }
  .card h2 { font-size:13px; color:#888; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; }

  .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; }
  .stat { text-align:center; }
  .stat .val { font-size:28px; font-weight:bold; }
  .stat .label { font-size:10px; color:#666; text-transform:uppercase; margin-top:2px; }
  .green { color:#34d399; }
  .blue { color:#60a5fa; }
  .amber { color:#fbbf24; }
  .purple { color:#818cf8; }
  .red { color:#f87171; }

  .workers-bars { display:flex; flex-direction:column; gap:6px; }
  .worker-bar { display:flex; align-items:center; gap:8px; }
  .worker-bar .name { width:70px; font-size:11px; color:#888; text-align:right; }
  .worker-bar .bar-bg { flex:1; height:20px; background:rgba(255,255,255,0.04); border-radius:4px; overflow:hidden; position:relative; }
  .worker-bar .bar-fill { height:100%; border-radius:4px; transition:width 0.5s; display:flex; align-items:center; padding-left:6px; font-size:10px; color:rgba(255,255,255,0.8); }
  .worker-bar .bar-fill.cpu { background:linear-gradient(90deg,#818cf8,#6366f1); }
  .worker-bar .bar-fill.mem { background:linear-gradient(90deg,#34d399,#059669); }
  .worker-bar .bar-fill.sandbox { background:linear-gradient(90deg,#60a5fa,#3b82f6); }
  .worker-bar .count { width:30px; font-size:11px; color:#ccc; text-align:right; }

  .event-feed { flex:1; overflow-y:auto; min-height:0; font-size:11px; }
  .event { padding:3px 0; animation:fadeIn 0.2s; }
  @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
  .event .time { color:#555; }
  .event .create { color:#34d399; }
  .event .destroy { color:#f87171; }
  .event .scale { color:#fbbf24; }
  .event .migrate { color:#818cf8; }

  .chaos-indicator { display:flex; align-items:center; gap:8px; padding:8px 12px; border-radius:6px; font-size:12px; }
  .chaos-indicator.active { background:rgba(248,113,113,0.1); border:1px solid rgba(248,113,113,0.2); color:#f87171; animation:chaosPulse 2s infinite; }
  .chaos-indicator.idle { background:rgba(52,211,153,0.1); border:1px solid rgba(52,211,153,0.2); color:#34d399; }
  @keyframes chaosPulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }

  .chaos-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
  .chaos-stat { text-align:center; padding:8px; background:rgba(255,255,255,0.02); border-radius:6px; }
  .chaos-stat .val { font-size:18px; font-weight:bold; }
  .chaos-stat .label { font-size:9px; color:#666; text-transform:uppercase; }
</style>
</head>
<body>
<div class="header">
  <h1>200-Sandbox Chaos Test</h1>
  <div class="sub">Random scaling, disk writes, creates, and destroys across 9 workers</div>
</div>

<div class="main">
  <div class="left">
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="val blue" id="workers">0</div><div class="label">Workers</div></div>
        <div class="stat"><div class="val green" id="sandboxes">0</div><div class="label">Sandboxes</div></div>
        <div class="stat"><div class="val amber" id="creates">0</div><div class="label">Creates</div></div>
        <div class="stat"><div class="val red" id="destroys">0</div><div class="label">Destroys</div></div>
        <div class="stat"><div class="val purple" id="scales">0</div><div class="label">Scales</div></div>
      </div>
    </div>

    <div class="card" style="flex:1">
      <h2>Worker Distribution</h2>
      <div class="workers-bars" id="worker-bars"></div>
    </div>

    <div class="card">
      <h2>Chaos Activity</h2>
      <div class="chaos-stats">
        <div class="chaos-stat"><div class="val green" id="c-creates">0</div><div class="label">Creates</div></div>
        <div class="chaos-stat"><div class="val red" id="c-destroys">0</div><div class="label">Destroys</div></div>
        <div class="chaos-stat"><div class="val purple" id="c-scales">0</div><div class="label">Mem Scales</div></div>
        <div class="chaos-stat"><div class="val amber" id="c-migrates">0</div><div class="label">Migrations</div></div>
      </div>
    </div>
  </div>

  <div class="right">
    <div class="card">
      <div class="chaos-indicator idle" id="chaos-status">
        Waiting for test...
      </div>
    </div>

    <div class="card" style="flex:1;display:flex;flex-direction:column;min-height:0">
      <h2>Live Events</h2>
      <div class="event-feed" id="events"></div>
    </div>
  </div>
</div>

<script>
const API_KEY = new URLSearchParams(window.location.search).get('key') || '';
const BASE = window.location.origin;
let creates = 0, destroys = 0, scales = 0, migrates = 0;
let prevSandboxes = 0;
let displayedSandboxes = 0;

function addEvent(msg, type) {
  const feed = document.getElementById('events');
  const el = document.createElement('div');
  el.className = 'event';
  el.innerHTML = '<span class="time">' + new Date().toLocaleTimeString() + '</span> <span class="' + type + '">' + msg + '</span>';
  feed.insertBefore(el, feed.firstChild);
  while (feed.children.length > 200) feed.removeChild(feed.lastChild);
}

async function refresh() {
  try {
    const resp = await fetch(BASE + '/api/workers', { headers: { 'X-API-Key': API_KEY } });
    const data = await resp.json();

    const totalSb = data.reduce((s,w) => s + w.current, 0);
    document.getElementById('workers').textContent = data.length;

    document.getElementById('sandboxes').textContent = totalSb;

    if (totalSb > 0) {
      const indicator = document.getElementById('chaos-status');
      indicator.className = 'chaos-indicator active';
      indicator.textContent = 'Chaos active — ' + totalSb + ' sandboxes';
    }
    prevSandboxes = totalSb;

    // Worker bars
    const maxSb = Math.max(1, ...data.map(w => w.current));
    const bars = document.getElementById('worker-bars');
    bars.innerHTML = data.sort((a,b) => b.current - a.current).map(w => {
      const pct = (w.current / Math.max(maxSb, 30)) * 100;
      const memPct = w.mem_pct;
      return '<div class="worker-bar">' +
        '<span class="name">' + w.worker_id.slice(-8) + '</span>' +
        '<div class="bar-bg"><div class="bar-fill sandbox" style="width:' + pct + '%">' + (w.current > 0 ? w.current : '') + '</div></div>' +
        '<span class="count" style="color:' + (memPct > 50 ? '#fbbf24' : '#888') + '">' + memPct.toFixed(0) + '%</span>' +
      '</div>';
    }).join('');

  } catch(e) {}
}

// SSE events
const evtSource = new EventSource(BASE + '/admin/events?key=' + API_KEY);
evtSource.onmessage = function(e) {
  try {
    const evt = JSON.parse(e.data);
    const sb = evt.sandbox ? evt.sandbox.slice(-8) : '';
    const wk = evt.worker ? evt.worker.slice(-8) : '';

    if (evt.type === 'create') {
      document.getElementById('c-creates').textContent = ++creates;
      addEvent('+' + sb + ' → ' + wk, 'create');
    } else if (evt.type === 'destroy') {
      document.getElementById('c-destroys').textContent = ++destroys;
      addEvent('-' + sb, 'destroy');
    } else if (evt.type === 'scale') {
      document.getElementById('c-scales').textContent = ++scales;
      document.getElementById('scales').textContent = scales;
      addEvent('~' + sb + ' ' + evt.detail, 'scale');
    } else if (evt.type === 'migrate') {
      document.getElementById('c-migrates').textContent = ++migrates;
      addEvent('→' + sb + ' ' + evt.detail, 'migrate');
    }
  } catch(err) {}
};

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`
