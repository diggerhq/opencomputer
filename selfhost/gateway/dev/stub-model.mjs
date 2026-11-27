// A stand-in Anthropic Messages API for the spike's end-to-end test: answers every
// POST /v1/messages with one streamed text block, "echo: <the last user text>", and
// /v1/messages/count_tokens with a fixed count. No model, no key.
//
//   node stub-model.mjs <cert.pem> <key.pem> [port=8443]

import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const [cert, key, port = "8443"] = process.argv.slice(2);

function lastUserText(body) {
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return user.content.filter((c) => c.type === "text").map((c) => c.text).filter((t) => !t.startsWith("<system-reminder>")).join(" ");
}

createServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const path = req.url.split("?")[0];
  console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path, model: body.model, apiKey: req.headers["x-api-key"] ? "present" : "absent", stream: body.stream }));
  if (path === "/v1/messages/count_tokens") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 42 }));
  if (path !== "/v1/messages") return res.writeHead(404).end();
  const text = `echo: ${lastUserText(body).slice(0, 500)}`;
  const id = `msg_stub_${Date.now()}`;
  const usage = { input_tokens: 42, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage };
  if (!body.stream) {
    return res.writeHead(200, { "content-type": "application/json", "request-id": id })
      .end(JSON.stringify({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn" }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": id });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", { message });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } });
  send("message_stop", {});
  res.end();
}).listen(Number(port), "127.0.0.1", () => console.log(`stub model on https://127.0.0.1:${port}`));
