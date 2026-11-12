// A stand-in for the Anthropic API that calls a tool when the person's
// message asks for one, so a dev check can drive the real runner and the real
// Agent SDK through a tool call with no model and no credential
// (sandbox-check.ts runs it inside a session's container, whose loopback is
// the only address the session's harness and this can share):
//   node src/dev/fake-model.mjs <port>
//
// A message whose text has `call <tool> <json>` is answered with a `tool_use`
// of the offered tool whose name is `<tool>` or ends in `__<tool>`; the
// request that carries its result is answered `done`, and the result's text
// is kept. `GET /calls` returns what was kept: `[{ tool, input, result }]`.
//
// Invariants: plain Node, no dependency, no file written: it runs from a
// release mounted read-only. It listens on 127.0.0.1 only.

import http from 'node:http';

const port = Number(process.argv[2]);
if (!port) {
  console.error('usage: fake-model.mjs <port>');
  process.exit(2);
}

/** @type {{ tool: string, input: unknown, result?: string }[]} */
const calls = [];
const ASK = /call ([a-z_]+) (\{[^\n]*\})/;

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : '')).join('\n') : '';

/** What the model "says" to a request body: a tool call, or a word. */
function answer(j) {
  const last = [...(j.messages ?? [])].reverse().find((m) => m.role === 'user');
  const blocks = Array.isArray(last?.content) ? last.content : [];
  const result = blocks.find((b) => b.type === 'tool_result');
  if (result) {
    const call = calls.find((c) => c.id === result.tool_use_id);
    if (call) call.result = textOf(result.content);
    return { text: 'done' };
  }
  const m = ASK.exec(textOf(last?.content));
  const tool = m && (j.tools ?? []).find((t) => t.name === m[1] || t.name.endsWith(`__${m[1]}`));
  if (!m || !tool) return { text: 'ok' };
  const call = { id: `toolu_${calls.length + 1}`, tool: tool.name, input: JSON.parse(m[2]) };
  calls.push(call);
  return { call };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (code, v) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
    if (req.method === 'GET' && req.url === '/calls') return json(200, calls.map(({ tool, input, result }) => ({ tool, input, result })));
    if (!req.url?.startsWith('/v1/messages')) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    if (req.url.startsWith('/v1/messages/count_tokens')) return json(200, { input_tokens: 10 });
    const j = body ? JSON.parse(body) : {};
    const a = j.stream ? answer(j) : { text: 'ok' }; // only a turn streams; the side requests (a title) get a word
    const content = a.call ? [{ type: 'tool_use', id: a.call.id, name: a.call.tool, input: a.call.input }] : [{ type: 'text', text: a.text }];
    const stop_reason = a.call ? 'tool_use' : 'end_turn';
    const msg = { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: j.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
    if (!j.stream) return json(200, msg);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    if (a.call) {
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: a.call.id, name: a.call.tool, input: {} } });
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(a.call.input) } });
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: a.text } });
    }
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
    ev('message_stop', {});
    res.end();
  });
});
server.listen(port, '127.0.0.1');
