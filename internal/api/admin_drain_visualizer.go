package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

// adminDrainVisualizerPage serves an operator-only view for watching live
// migration drains. It intentionally lives under /admin so the existing API-key
// middleware guards the drain/evacuate controls.
func (s *Server) adminDrainVisualizerPage(c echo.Context) error {
	return c.HTML(http.StatusOK, adminDrainVisualizerHTML)
}

const adminDrainVisualizerHTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenComputer drain visualizer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b10;
      --panel: #11151d;
      --panel-2: #171c25;
      --line: #29313f;
      --text: #eef2f7;
      --muted: #8d97a8;
      --accent: #4cc9a7;
      --warn: #f4b740;
      --bad: #ef6f78;
      --tile: #202838;
      --tile-moving: #224b44;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 22px;
      border-bottom: 1px solid var(--line);
      background: rgba(17,21,29,.94);
      position: sticky;
      top: 0;
      z-index: 3;
    }
    h1 { font-size: 15px; margin: 0; font-weight: 700; }
    .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    input {
      width: 260px;
      background: #0d1017;
      border: 1px solid var(--line);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    button {
      background: var(--panel-2);
      border: 1px solid var(--line);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 11px;
      font: inherit;
      cursor: pointer;
    }
    button.primary { background: #123d35; border-color: #236a5b; color: #dffcf5; }
    button.warn { background: #3a2710; border-color: #74511c; color: #ffe2a8; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    main { padding: 18px 22px 26px; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .stat {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .stat .value { margin-top: 5px; font-size: 20px; font-weight: 750; font-variant-numeric: tabular-nums; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
      align-items: start;
    }
    .worker {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-height: 220px;
      overflow: hidden;
    }
    .worker.draining { border-color: #8a6720; box-shadow: inset 0 0 0 1px rgba(244,183,64,.22); }
    .worker-head {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 8px;
    }
    .worker-title { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .worker-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .badge {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .badge.drain { color: #ffd98b; border-color: #74511c; background: rgba(244,183,64,.12); }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .metric { background: #0d1017; border: 1px solid #202735; border-radius: 6px; padding: 6px; }
    .metric span { display: block; color: var(--muted); font-size: 10px; }
    .metric b { display: block; margin-top: 2px; font-size: 12px; font-variant-numeric: tabular-nums; }
    .actions { display: flex; gap: 6px; }
    .actions button { flex: 1; padding: 7px 8px; font-size: 12px; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 7px; padding: 10px; }
    .tile {
      min-height: 48px;
      background: var(--tile);
      border: 1px solid #303a4d;
      border-radius: 7px;
      padding: 7px;
      transition: transform .18s ease, background .18s ease, border-color .18s ease;
      animation: tile-in .22s ease-out;
    }
    .tile.moved {
      background: var(--tile-moving);
      border-color: #3aa891;
      transform: translateY(-2px);
    }
    .tile-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tile-stats { margin-top: 5px; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
    .empty { color: var(--muted); padding: 22px 10px; text-align: center; }
    .events {
      margin-top: 16px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .events h2 { margin: 0; padding: 12px; font-size: 13px; border-bottom: 1px solid var(--line); }
    .event-list { max-height: 220px; overflow: auto; }
    .event {
      display: grid;
      grid-template-columns: 70px 86px 1fr;
      gap: 8px;
      padding: 7px 12px;
      border-bottom: 1px solid rgba(41,49,63,.65);
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
    }
    .event strong { color: var(--text); font-weight: 600; }
    .notice { color: var(--muted); }
    .error { color: #ff9aa2; }
    @keyframes tile-in {
      from { opacity: 0; transform: scale(.96); }
      to { opacity: 1; transform: scale(1); }
    }
    @media (max-width: 760px) {
      header { height: auto; align-items: flex-start; flex-direction: column; gap: 10px; padding: 14px; }
      main { padding: 14px; }
      input { width: min(100%, 320px); }
      .summary { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <header>
    <h1>Drain visualizer</h1>
    <div class="toolbar">
      <span id="status" class="notice">connecting</span>
      <input id="apiKey" type="password" placeholder="Admin API key">
      <button id="saveKey">Save key</button>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <section class="summary">
      <div class="stat"><div class="label">Workers</div><div id="workerCount" class="value">0</div></div>
      <div class="stat"><div class="label">Sandboxes</div><div id="sandboxCount" class="value">0</div></div>
      <div class="stat"><div class="label">Draining</div><div id="drainingCount" class="value">0</div></div>
      <div class="stat"><div class="label">Moves</div><div id="moveCount" class="value">0</div></div>
    </section>
    <section id="workers" class="grid"></section>
    <section class="events">
      <h2>Events</h2>
      <div id="events" class="event-list"></div>
    </section>
  </main>
  <script>
    const BASE = location.origin;
    const qsKey = new URLSearchParams(location.search).get('key') || '';
    const keyInput = document.getElementById('apiKey');
    const statusEl = document.getElementById('status');
    const eventsEl = document.getElementById('events');
    const workerGrid = document.getElementById('workers');
    let apiKey = qsKey || localStorage.getItem('oc_admin_key') || '';
    let previousPlacement = new Map();
    let recentlyMoved = new Map();
    let moveCount = 0;
    let eventSource = null;
    keyInput.value = apiKey;

    function shortId(id) {
      if (!id) return '';
      return id.length > 18 ? id.slice(0, 10) + '...' + id.slice(-6) : id;
    }
    function headers() {
      return apiKey ? { 'X-API-Key': apiKey } : {};
    }
    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.className = isError ? 'error' : 'notice';
    }
    function pct(n) {
      if (n === undefined || n === null || Number.isNaN(Number(n))) return '0%';
      return Math.round(Number(n)) + '%';
    }
    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]);
    }
    function jsArg(value) {
      return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');
    }
    function addEvent(evt) {
      const row = document.createElement('div');
      row.className = 'event';
      row.innerHTML =
        '<span>' + esc(evt.time || new Date().toLocaleTimeString()) + '</span>' +
        '<strong>' + esc(evt.type || 'event') + '</strong>' +
        '<span>' + esc([evt.sandbox, evt.worker, evt.detail].filter(Boolean).join(' | ')) + '</span>';
      eventsEl.prepend(row);
      while (eventsEl.children.length > 80) eventsEl.removeChild(eventsEl.lastChild);
    }
    function connectEvents() {
      if (!apiKey) return;
      if (eventSource) eventSource.close();
      eventSource = new EventSource(BASE + '/admin/events?key=' + encodeURIComponent(apiKey));
      eventSource.onmessage = (e) => {
        try { addEvent(JSON.parse(e.data)); } catch (_) {}
      };
      eventSource.onerror = () => setStatus('event stream reconnecting', true);
    }
    async function api(path, opts) {
      const resp = await fetch(BASE + path, { ...(opts || {}), headers: { ...headers(), ...((opts || {}).headers || {}) } });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || ('HTTP ' + resp.status));
      }
      return resp.status === 204 ? null : resp.json();
    }
    async function setDrain(workerID, drain) {
      setStatus((drain ? 'draining ' : 'clearing ') + shortId(workerID), false);
      await api('/admin/workers/' + encodeURIComponent(workerID) + '/drain?drain=' + String(drain), { method: 'POST' });
      await load();
    }
    async function evacuate(workerID) {
      setStatus('evacuating ' + shortId(workerID), false);
      await api('/admin/workers/' + encodeURIComponent(workerID) + '/evacuate', { method: 'POST' });
      addEvent({ type: 'evacuate', worker: workerID, detail: 'manual evacuation started' });
      await load();
    }
    window.setDrain = setDrain;
    window.evacuate = evacuate;
    function sandboxEntries(worker) {
      const sandboxes = worker.sandboxes || worker.Sandboxes || {};
      const live = Object.keys(sandboxes).sort().map((id) => ({ id, stats: sandboxes[id] || {}, source: 'worker' }));
      const current = Number(worker.current || 0);
      if (live.length === current) return live;

      const wid = worker.worker_id || worker.id;
      const listed = sandboxesByWorker.get(wid) || [];
      if (listed.length > 0) return listed;
      return live;
    }
    let sandboxesByWorker = new Map();
    function indexSandboxes(sandboxes) {
      sandboxesByWorker = new Map();
      for (const sb of sandboxes || []) {
        const workerID = sb.workerID || sb.workerId || sb.worker_id;
        const sandboxID = sb.sandboxID || sb.sandboxId || sb.id;
        if (!workerID || !sandboxID) continue;
        const list = sandboxesByWorker.get(workerID) || [];
        list.push({ id: sandboxID, stats: {}, source: 'api' });
        sandboxesByWorker.set(workerID, list);
      }
      for (const list of sandboxesByWorker.values()) {
        list.sort((a, b) => a.id.localeCompare(b.id));
      }
    }
    function render(workers) {
      workers.sort((a, b) => (b.current || 0) - (a.current || 0) || String(a.worker_id || a.id).localeCompare(String(b.worker_id || b.id)));
      const nextPlacement = new Map();
      const seenSandboxes = new Set();
      let sandboxes = 0;
      let draining = 0;
      for (const w of workers) {
        const wid = w.worker_id || w.id;
        if (w.draining) draining++;
        for (const sb of sandboxEntries(w)) {
          if (seenSandboxes.has(sb.id)) continue;
          seenSandboxes.add(sb.id);
          sandboxes++;
          nextPlacement.set(sb.id, wid);
          const prev = previousPlacement.get(sb.id);
          if (prev && prev !== wid) {
            recentlyMoved.set(sb.id, Date.now() + 5000);
            moveCount++;
            addEvent({ type: 'move', sandbox: sb.id, worker: wid, detail: prev + ' -> ' + wid });
          }
        }
      }
      previousPlacement = nextPlacement;
      const now = Date.now();
      for (const [id, until] of recentlyMoved.entries()) {
        if (until < now) recentlyMoved.delete(id);
      }
      document.getElementById('workerCount').textContent = workers.length;
      document.getElementById('sandboxCount').textContent = sandboxes;
      document.getElementById('drainingCount').textContent = draining;
      document.getElementById('moveCount').textContent = moveCount;
      workerGrid.innerHTML = workers.map((w) => {
        const wid = w.worker_id || w.id;
        const rendered = new Set();
        const tiles = sandboxEntries(w).filter((sb) => {
          if (rendered.has(sb.id)) return false;
          rendered.add(sb.id);
          return true;
        });
        return '<article class="worker ' + (w.draining ? 'draining' : '') + '">' +
          '<div class="worker-head">' +
            '<div class="worker-title"><div class="worker-id" title="' + esc(wid) + '">' + esc(shortId(wid)) + '</div>' +
              '<span class="badge ' + (w.draining ? 'drain' : '') + '">' + (w.draining ? 'draining' : 'active') + '</span></div>' +
            '<div class="metrics">' +
              '<div class="metric"><span>load</span><b>' + (w.current || 0) + '/' + (w.capacity || 0) + '</b></div>' +
              '<div class="metric"><span>cpu</span><b>' + pct(w.cpu_pct) + '</b></div>' +
              '<div class="metric"><span>mem</span><b>' + pct(w.mem_pct) + '</b></div>' +
              '<div class="metric"><span>disk</span><b>' + pct(w.disk_pct) + '</b></div>' +
            '</div>' +
            '<div class="actions">' +
              '<button type="button" class="warn" data-action="drain" data-worker="' + esc(wid) + '">Drain</button>' +
              '<button type="button" class="primary" data-action="evacuate" data-worker="' + esc(wid) + '">Evacuate</button>' +
              '<button type="button" data-action="clear" data-worker="' + esc(wid) + '">Clear</button>' +
            '</div>' +
          '</div>' +
          '<div class="tiles">' +
            (tiles.length ? tiles.map((sb) => {
              const moved = recentlyMoved.has(sb.id);
              const cpu = sb.stats.cpu_pct ?? sb.stats.cpuPct ?? 0;
              const mem = sb.stats.mem_pct ?? sb.stats.memPct ?? 0;
              return '<div class="tile ' + (moved ? 'moved' : '') + '" title="' + esc(sb.id) + '">' +
                '<div class="tile-id">' + esc(shortId(sb.id)) + '</div>' +
                '<div class="tile-stats">cpu ' + pct(cpu) + ' / mem ' + pct(mem) + '</div>' +
              '</div>';
            }).join('') : '<div class="empty">empty</div>') +
          '</div>' +
        '</article>';
      }).join('');
    }
    async function load() {
      if (!apiKey) {
        setStatus('admin key required', true);
        return;
      }
      try {
        const [workers, sandboxes] = await Promise.all([
          api('/api/workers'),
          api('/api/sandboxes').catch(() => []),
        ]);
        indexSandboxes(Array.isArray(sandboxes) ? sandboxes : []);
        render(Array.isArray(workers) ? workers : []);
        setStatus('live ' + new Date().toLocaleTimeString(), false);
      } catch (err) {
        setStatus(err.message || String(err), true);
      }
    }
    document.getElementById('saveKey').onclick = () => {
      apiKey = keyInput.value.trim();
      if (apiKey) localStorage.setItem('oc_admin_key', apiKey);
      connectEvents();
      load();
    };
    document.getElementById('refresh').onclick = load;
    workerGrid.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const workerID = button.getAttribute('data-worker');
      const action = button.getAttribute('data-action');
      if (!workerID || !action) return;
      button.disabled = true;
      try {
        if (action === 'drain') await setDrain(workerID, true);
        else if (action === 'clear') await setDrain(workerID, false);
        else if (action === 'evacuate') await evacuate(workerID);
      } catch (err) {
        setStatus(err.message || String(err), true);
      } finally {
        button.disabled = false;
      }
    });
    connectEvents();
    load();
    setInterval(load, 1000);
  </script>
</body>
</html>`
