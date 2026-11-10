#!/usr/bin/env node
// A stand-in for `codex app-server` in tests: replays a transcript recorded
// from Codex 0.163.0 (FAKE_CODEX_TRANSCRIPT, one {dir, ms, m} per line).
// Each request the client sends is matched to the next recorded request of
// the same method; what Codex sent after it, up to the client's next
// recorded message, is replayed, with the response's id rewritten to the
// client's. A recorded server request waits for the client's answer.
// model/list and thread/resume are answered here (not in the recordings).
// FAKE_CODEX_LOG: every received line, after one line of the environment it
// saw. FAKE_CODEX_EXIT_ON: exit (code 3) instead of sending that method.
import fs from 'node:fs';
import readline from 'node:readline';

const rec = fs
  .readFileSync(process.env.FAKE_CODEX_TRANSCRIPT, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const logTo = process.env.FAKE_CODEX_LOG;
const note = (x) => logTo && fs.appendFileSync(logTo, JSON.stringify(x) + '\n');
const seen = ['CODEX_HOME', 'CALVIN_MODEL_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'CODEX_API_KEY', 'BASH_ENV', 'RUST_LOG', 'HOME', 'SP_TOKEN_SOCKET', 'SP_FILES_SOCKET', 'GIT_COMMITTER_NAME'];
note({ env: Object.fromEntries(seen.map((k) => [k, process.env[k] ?? null])), argv: process.argv.slice(2), cwd: process.cwd() });

const thread = rec.find((r) => r.m?.result?.thread)?.m.result.thread;
// The shape and the served models of Codex 0.163.0's model/list (gpt-5.3-codex is not among them).
const efforts = (...es) => es.map((reasoningEffort) => ({ reasoningEffort, description: '' }));
const fast = [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }];
const CATALOG = {
  data: [
    { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts('low', 'medium', 'high'), serviceTiers: fast },
    { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', hidden: false, isDefault: false, supportedReasoningEfforts: efforts('low', 'medium', 'high'), serviceTiers: fast },
    { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, isDefault: false, supportedReasoningEfforts: efforts('low', 'medium', 'high') },
    { id: 'gpt-old', model: 'gpt-old', displayName: 'Old', hidden: true, isDefault: false, supportedReasoningEfforts: [] },
  ],
};

let pos = 0;
const answers = new Map();
const send = (m) => {
  if (m.method && m.method === process.env.FAKE_CODEX_EXIT_ON) process.exit(3);
  process.stdout.write(JSON.stringify(m) + '\n');
};
const answered = (id) => new Promise((res) => (answers.has(id) ? res(answers.get(id)) : answers.set(id, res)));

let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  note(m);
  if (m.method === undefined) {
    const w = answers.get(m.id);
    if (typeof w === 'function') w(m);
    else answers.set(m.id, m);
    return;
  }
  chain = chain.then(() => serve(m));
});

async function serve(m) {
  if (m.method === 'model/list') return send({ id: m.id, result: CATALOG });
  if (m.method === 'thread/resume') {
    if (process.env.FAKE_CODEX_RESUME && thread) return send({ id: m.id, result: { thread } });
    return send({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${m.params.threadId}` } });
  }
  const at = rec.findIndex((r, i) => i >= pos && r.dir === 'out' && r.m.method === m.method);
  if (at < 0) return m.id !== undefined && send({ id: m.id, error: { code: -32601, message: `fake codex has no ${m.method}` } });
  const recId = rec[at].m.id;
  let i = at + 1;
  for (; i < rec.length; i++) {
    const r = rec[i];
    if (r.dir === 'out') {
      if (r.m.method !== undefined) break; // the client's next message: stop here
      continue; // the client's answer to a server request, awaited below
    }
    if (r.dir !== 'in') continue;
    if (r.m.method === undefined && r.m.id === recId) send({ ...r.m, id: m.id });
    else if (r.m.method !== undefined && r.m.id !== undefined) {
      send(r.m);
      await answered(r.m.id);
    } else send(r.m);
  }
  pos = i;
}
