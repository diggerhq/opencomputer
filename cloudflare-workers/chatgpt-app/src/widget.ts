export const WIDGET_URI = "ui://opencomputer/session-v1.html";

// Renders a session view (the structuredContent of run_agent, send_message and get_session).
// It speaks the MCP Apps bridge (JSON-RPC over postMessage) and falls back to window.openai.
// Every value it shows is untrusted and set through textContent only.
const WIDGET_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: light dark; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  body { margin: 0; padding: 12px; }
  header { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
  header .agent { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, transparent); }
  .pill.running { background: #dbeafe; color: #1e40af; } .pill.failed { background: #fee2e2; color: #991b1b; }
  .turn { border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent); padding: 8px 0; }
  .you { color: color-mix(in srgb, CanvasText 65%, transparent); white-space: pre-wrap; }
  .reply { white-space: pre-wrap; margin-top: 4px; }
  .tools { font-size: 12px; color: color-mix(in srgb, CanvasText 55%, transparent); margin-top: 4px; }
  .error { color: #b91c1c; margin-top: 4px; }
  form { display: flex; gap: 6px; margin-top: 10px; }
  input { flex: 1; padding: 7px 9px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); font: inherit; background: Canvas; color: CanvasText; }
  button { padding: 7px 12px; border-radius: 8px; border: 0; font: inherit; font-weight: 600; background: CanvasText; color: Canvas; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .muted { font-size: 12px; color: color-mix(in srgb, CanvasText 55%, transparent); }
</style></head><body>
<header><span class="agent" id="agent">OpenComputer agent</span><span class="pill" id="status">…</span></header>
<div id="turns"><p class="muted">Waiting for the agent…</p></div>
<form id="reply"><input id="message" placeholder="Reply to the agent" autocomplete="off"><button id="send">Send</button></form>
<script>
(() => {
  let view = null, nextId = 1, timer = null;
  const pending = new Map();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };

  function rpc(method, params) {
    const id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  async function callTool(name, args) {
    if (window.openai && typeof window.openai.callTool === "function") return window.openai.callTool(name, args);
    return rpc("tools/call", { name, arguments: args });
  }

  function render(next) {
    if (!next || !next.session || !Array.isArray(next.turns)) return;
    view = next;
    $("agent").textContent = String(next.session.agentId || "OpenComputer agent");
    const status = next.running ? "running" : String(next.session.status || "");
    $("status").textContent = status;
    $("status").className = "pill " + (next.running ? "running" : status === "failed" ? "failed" : "");
    const list = $("turns");
    list.replaceChildren();
    if (next.omittedTurns > 0) list.append(el("p", "muted", next.omittedTurns + " earlier turns not shown"));
    for (const turn of next.turns) {
      const row = el("div", "turn");
      row.append(el("div", "you", "You: " + String(turn.input || "")));
      if (turn.reply) row.append(el("div", "reply", String(turn.reply)));
      else if (turn.status === "queued" || turn.status === "running") row.append(el("div", "muted", "Working…"));
      if (Array.isArray(turn.tools) && turn.tools.length) row.append(el("div", "tools", "Used: " + turn.tools.map(String).join(", ")));
      if (turn.error) row.append(el("div", "error", String(turn.error)));
      list.append(row);
    }
    const open = next.session.status !== "ended" && next.session.status !== "failed";
    $("reply").style.display = open ? "flex" : "none";
    clearTimeout(timer);
    if (next.running) timer = setTimeout(refresh, 3000);
  }
  function fromResult(result) { if (result && result.structuredContent) render(result.structuredContent); }

  async function refresh() {
    if (!view) return;
    try { fromResult(await callTool("get_session", { sessionId: view.session.id })); } catch (_) {}
  }

  $("reply").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("message").value.trim();
    if (!text || !view) return;
    $("send").disabled = true;
    try {
      fromResult(await callTool("send_message", { sessionId: view.session.id, input: text, waitSeconds: 20 }));
      $("message").value = "";
    } catch (_) {
    } finally { $("send").disabled = false; }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p.reject(message.error); else p.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") fromResult(message.params);
  }, { passive: true });

  window.addEventListener("openai:set_globals", () => { if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput); });
  if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);

  rpc("ui/initialize", { appInfo: { name: "opencomputer-session", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(() => window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*"))
    .catch(() => {});
})();
</script></body></html>`;

export function widgetResource() {
  return {
    uri: WIDGET_URI,
    mimeType: "text/html;profile=mcp-app",
    text: WIDGET_HTML,
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetPrefersBorder": true,
      "openai/widgetDescription": "Shows the agent session transcript and lets the user reply to the agent.",
    },
  };
}
