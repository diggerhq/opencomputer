// Minimal mock OpenRouter for the local integration proof. Records the Authorization header it
// received (to prove the gateway injected the ORG key, not the session token) and echoes an
// Anthropic-Messages-shaped response carrying usage.cost (what the on-path meter reads).
import { createServer } from "node:http";

let lastAuth = null;
let lastBody = null;
const PORT = Number(process.env.MOCK_PORT || 8799);

createServer((req, res) => {
  if (req.url === "/__spy") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ lastAuth, lastBody }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastAuth = req.headers["authorization"] || null;
    try { lastBody = JSON.parse(body); } catch { lastBody = body; }
    // Echo an anthropic-style completion with an OpenRouter cost echo.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "gen-" + Math.floor(Date.now() / 1000),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "pong from mock" }],
      usage: { input_tokens: 12, output_tokens: 4, cost: 0.02 }, // $0.02 per call
    }));
  });
}).listen(PORT, () => console.log(`mock-openrouter on :${PORT}`));
