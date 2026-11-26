#!/usr/bin/env node
// The rehearsal of deploy 1 (work 118; spec 43.1): move one organization's
// Computer rows from one environment into a development stack and run Org's
// adoption and the Slack actor's import over them. The rows and what never
// moves: src/computer/rehearsal.ts. The checklist around it:
// serverless-agents-ws product/tracks-and-threads/work/rehearsal.md.
//
//   rehearsal.mjs export --from <edge url> --org <id> --out <file>
//       Reads only. Needs REHEARSAL_KEY set on that Worker and in this env.
//   rehearsal.mjs synth --out <file> [--sessions 400] [--team T0REHEARSE]
//       A busy organization made up here: Slack threads (some without a cs_
//       id, as before the API), API sessions, archived and idle ones, people,
//       a pending dispatch, queued Slack jobs.
//   rehearsal.mjs import --to <edge url> --org <id> --in <file> [--team <id>] [--keep-pending]
//       Loads the file into <id>'s Computer object on a development stack
//       (refused in production), then runs the migration and prints what Org
//       adopted. --team rewrites the file's Slack team id to the stack's
//       workspace. A dispatch still pending would become a turn the stack's
//       computer runs: it is loaded as `held` unless --keep-pending.
//
// A file is JSON lines: {"table": "...", "row": {...}}, first line a header
// {"rehearsal": 1, "org": "...", "team": "..."}. It holds session titles,
// summaries, people's names and emails, and queued message text: keep it out
// of repositories and delete it after the rehearsal.
import fs from "node:fs";

const TABLES = ["settings", "sessions", "dispatches", "people", "slack_messages", "slack_queue", "join_requests", "notices", "billing_warnings", "session_context", "access_requests"];
const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  const name = rest[i].replace(/^--/, "");
  if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) flags[name] = true;
  else flags[name] = rest[(i += 1)];
}
const need = (name) => flags[name] ?? fail(`--${name} is required`);
function fail(message) {
  console.error(`rehearsal: ${message}`);
  process.exit(1);
}

async function call(base, action, org, body) {
  const key = process.env.REHEARSAL_KEY ?? fail("REHEARSAL_KEY is not set");
  const response = await fetch(`${base.replace(/\/$/, "")}/internal/computer/rehearsal/${action}?account_id=${encodeURIComponent(org)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) fail(`${action} answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function read(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const header = lines.shift();
  if (header?.rehearsal !== 1) fail(`${file} is not a rehearsal file`);
  return { header, lines };
}

function counts(lines) {
  const n = {};
  for (const line of lines) n[line.table] = (n[line.table] ?? 0) + 1;
  return n;
}

async function exportOrg() {
  const [from, org, out] = [need("from"), need("org"), need("out")];
  const lines = [];
  for (const table of TABLES) {
    for (let offset = 0; offset !== null; ) {
      const page = await call(from, "dump", org, { table, offset });
      for (const row of page.rows) lines.push({ table, row });
      offset = page.next;
    }
  }
  const team = lines.find((l) => l.table === "settings" && l.row.key === "slackTeamId")?.row.value ?? null;
  fs.writeFileSync(out, [{ rehearsal: 1, org, team }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ out, org, team, rows: counts(lines) }));
}

function synth() {
  const out = need("out");
  const total = Number(flags.sessions ?? 400);
  const team = typeof flags.team === "string" ? flags.team : "T0REHEARSE";
  const org = "org_synthetic";
  const now = Date.now();
  const day = 86_400_000;
  const id = (prefix, n, length) => `${prefix}_${n.toString(32).padStart(length, "0").replace(/[ilou]/g, "z")}`;
  const lines = [];
  const add = (table, row) => lines.push({ table, row });
  for (const [key, value] of [["slackTeamId", team], ["slackTeamName", "Rehearsal"], ["slackBotUserId", "U0BOT"], ["slackInstallerUserId", "U0P0"]]) add("settings", { key, value });
  const people = Array.from({ length: 25 }, (_, i) => `U0P${i}`);
  for (const [i, user] of people.entries()) add("people", { slack_user_id: user, dir: `slack-${user}`, git_name: `Person ${i}`, git_email: `person${i}@example.com`, updated_at: now - i * day });
  for (let i = 0; i < total; i += 1) {
    const created = now - Math.floor(((total - i) / total) * 120 * day);
    const active = i % 5 === 0 ? created : Math.min(now, created + 3 * day);
    const owner = people[i % people.length];
    const slack = i % 3 !== 0;
    const base = {
      title: `Session ${i}: ${["fix the flaky deploy check", "why is the export slow", "draft the launch note", "bump the SDK"][i % 4]}`,
      mode: "default", model: "opus-5.5", created_at: created, updated_at: active, last_active_at: active,
      archived: i % 11 === 0 ? 1 : 0, api_status: "idle", drivers: i % 17 === 0 ? JSON.stringify([`slack:${team}:${owner}`]) : "*",
      metadata: i % 9 === 0 ? JSON.stringify({ ticket: `OC-${i}` }) : null,
    };
    if (slack) {
      const channel = `C0CH${i % 7}`;
      const ts = `${Math.floor(created / 1000)}.${String(i).padStart(6, "0")}`;
      // One Slack thread in four is from before the API: no cs_ id, the export mints it.
      add("sessions", { ...base, runner_key: `${team}:${channel}:${ts}`, team_id: team, channel_id: channel, thread_ts: ts, owner_id: owner, origin_type: "slack", session_id: i % 4 === 1 ? null : id("cs", i + 1, 16) });
    } else {
      const sid = id("cs", i + 1, 16);
      add("sessions", { ...base, runner_key: sid, team_id: "", channel_id: "", thread_ts: "", owner_id: null, origin_type: i % 2 ? "opc" : "api", origin_client: "rehearsal", session_id: sid, owner_user_id: `usr_${i % 6}`, owner_name: `User ${i % 6}`, owner_email: `user${i % 6}@example.com` });
    }
  }
  const threads = lines.filter((l) => l.table === "sessions" && l.row.origin_type === "slack" && l.row.session_id);
  const last = threads[threads.length - 1].row;
  add("dispatches", { id: "00000000-0000-4000-8000-000000000001", runner_key: last.runner_key, payload: JSON.stringify({ text: "Reply with the word rehearsal.", userId: last.owner_id }), state: "pending", attempts: 0, last_error: null, created_at: now, updated_at: now });
  add("dispatches", { id: "00000000-0000-4000-8000-000000000002", runner_key: last.runner_key, payload: JSON.stringify({ text: "old", userId: last.owner_id }), state: "done", attempts: 1, last_error: null, created_at: now - day, updated_at: now - day });
  for (let i = 0; i < 300; i += 1) add("slack_messages", { message_key: `${team}:C0CH${i % 7}:${Math.floor(now / 1000) - i}.000100`, received_at: now - i * 1000 });
  fs.writeFileSync(out, [{ rehearsal: 1, org, team }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ out, org, team, rows: counts(lines) }));
}

async function importOrg() {
  const [to, org, file] = [need("to"), need("org"), need("in")];
  const { header, lines } = read(file);
  // The organization and the team are rewritten wherever they are written, payloads included.
  const swap = [[header.org, org], ...(typeof flags.team === "string" && header.team ? [[header.team, flags.team]] : [])];
  const rewritten = lines.map((line) => {
    let text = JSON.stringify(line.row);
    for (const [from, into] of swap) if (from && from !== into) text = text.split(from).join(into);
    const row = JSON.parse(text);
    if (line.table === "dispatches" && !flags["keep-pending"] && (row.state === "pending" || row.state === "sent")) row.state = "held";
    return { table: line.table, row };
  });
  const written = {};
  for (const table of TABLES) {
    const rows = rewritten.filter((l) => l.table === table).map((l) => l.row);
    for (let i = 0; i < rows.length; i += 200) {
      written[table] = (written[table] ?? 0) + (await call(to, "load", org, { table, rows: rows.slice(i, i + 200) })).written;
    }
  }
  console.log(JSON.stringify({ loaded: written }));
  let state = { adopted: null, imported: null };
  for (let attempt = 0; attempt < 5 && !(state.adopted && state.imported); attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 3000));
    state = await call(to, "migrate", org);
  }
  console.log(JSON.stringify({ migrate: state, sessions: written.sessions ?? 0 }));
  if (!state.adopted || !state.imported) fail("the migration did not finish: `wrangler tail` the edge for computer.migrate_failed");
}

if (command === "export") await exportOrg();
else if (command === "synth") synth();
else if (command === "import") await importOrg();
else fail("usage: rehearsal.mjs export|synth|import (see the header of this file)");
