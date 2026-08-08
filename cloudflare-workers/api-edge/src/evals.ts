// evals.ts — native agent evals (input/output), edge-owned.
//
// A dataset is a set of { input, expect } examples for one deployed agent. A run executes every
// example as an isolated /v3 session against that agent and scores the output. The runner is
// runtime-agnostic — it drives the public session API (POST /v3/sessions → poll GET /result), so
// flue, langgraph, claude, codex and pi are all just "the agent under test". State lives in D1;
// the run advances via a small state machine (pending → running → done/failed) kicked by
// ctx.waitUntil after create and reconciled by the 5-min cron — no Durable Object needed.

import type { DashboardEnv } from "./dashboard";
import { mintOrgToken } from "./dashboard";

// ── shapes ─────────────────────────────────────────────────────────────────
interface Expect {
  contains?: string[];        // every substring present (case-insensitive)
  equals?: string;            // normalized exact match
  iregex?: string;            // case-insensitive regex match
  outcome?: string;           // terminal turn state must equal this (e.g. "ok")
  tools?: string[];           // every named tool was called (needs the event trace)
  max_cost_usd?: number;      // turn cost at or under this
}
interface Example { id: string; input: string; expect?: Expect }
interface Score { name: string; pass: boolean; detail?: string }
interface EvalCaller { orgID: string; userID: string }

interface DatasetRow {
  id: string; org_id: string; agent_id: string; name: string;
  examples: string; created_at: number; updated_at: number;
}
interface RunRow {
  id: string; org_id: string; dataset_id: string; agent_id: string; status: string;
  total: number; completed: number; passed: number; score: number | null;
  error: string | null; created_at: number; updated_at: number; finished_at: number | null;
}
interface ResultRow {
  id: string; run_id: string; org_id: string; example_id: string; input: string; expect: string;
  state: string; session_id: string | null; output: string | null; outcome: string | null;
  cost_usd: number | null; tokens: number | null; scores: string; passed: number | null;
  error: string | null; attempts: number; created_at: number; updated_at: number;
}

const OUTPUT_CAP = 8_192;
const START_BATCH = 5;          // pending examples started per pass
const ADVANCE_BUDGET_MS = 25_000;
const MAX_ATTEMPTS = 4;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => Math.floor(Date.now() / 1000);
const rid = (prefix: string): string => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + "_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── router ───────────────────────────────────────────────────────────────
export async function handleEvals(
  req: Request, env: DashboardEnv, caller: EvalCaller, ctx: ExecutionContext, sub: string, method: string,
): Promise<Response> {
  let m: RegExpMatchArray | null;

  // dataset collection (agent-scoped via ?agent_id= on GET, body.agent_id on POST)
  if (sub === "/evals") {
    if (method === "GET") return listDatasets(req, env, caller);
    if (method === "POST") return createDataset(req, env, caller);
  }
  // per-run (order before the dataset pattern so "runs" isn't read as a dataset id)
  if ((m = sub.match(/^\/evals\/runs\/([^/]+)\/results$/)) && method === "GET") return listResults(env, caller, m[1]);
  if ((m = sub.match(/^\/evals\/runs\/([^/]+)$/)) && method === "GET") return getRun(env, caller, m[1]);
  // per-dataset runs
  if ((m = sub.match(/^\/evals\/([^/]+)\/runs$/))) {
    if (method === "GET") return listRuns(env, caller, m[1]);
    if (method === "POST") return createRun(env, caller, ctx, m[1]);
  }
  // single dataset
  if ((m = sub.match(/^\/evals\/([^/]+)$/))) {
    if (method === "GET") return getDataset(env, caller, m[1]);
    if (method === "PATCH") return updateDataset(req, env, caller, m[1]);
    if (method === "DELETE") return deleteDataset(env, caller, m[1]);
  }
  return json({ error: "not found" }, 404);
}

// ── datasets ───────────────────────────────────────────────────────────────
async function listDatasets(req: Request, env: DashboardEnv, caller: EvalCaller): Promise<Response> {
  const agentId = new URL(req.url).searchParams.get("agent_id");
  if (!agentId) return json({ error: "agent_id is required" }, 400);
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT * FROM eval_datasets WHERE org_id = ?1 AND agent_id = ?2 ORDER BY updated_at DESC LIMIT 200`,
  ).bind(caller.orgID, agentId).all<DatasetRow>();
  return json({ data: (results ?? []).map(serializeDataset) });
}

async function getDataset(env: DashboardEnv, caller: EvalCaller, id: string): Promise<Response> {
  const row = await loadDataset(env, caller.orgID, id);
  if (!row) return json({ error: "dataset not found" }, 404);
  return json(serializeDataset(row));
}

async function createDataset(req: Request, env: DashboardEnv, caller: EvalCaller): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: string; agent_id?: string; examples?: unknown };
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!agentId) return json({ error: "agent_id is required" }, 400);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled";
  const examples = normalizeExamples(body.examples);
  if (examples.error) return json({ error: examples.error }, 400);
  const id = rid("evd"), ts = now();
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO eval_datasets (id, org_id, agent_id, name, examples, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  ).bind(id, caller.orgID, agentId, name, JSON.stringify(examples.list), ts).run();
  const row = await loadDataset(env, caller.orgID, id);
  return json(serializeDataset(row!), 201);
}

async function updateDataset(req: Request, env: DashboardEnv, caller: EvalCaller, id: string): Promise<Response> {
  const row = await loadDataset(env, caller.orgID, id);
  if (!row) return json({ error: "dataset not found" }, 404);
  const body = (await req.json().catch(() => ({}))) as { name?: string; examples?: unknown };
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : row.name;
  let examplesJson = row.examples;
  if (body.examples !== undefined) {
    const examples = normalizeExamples(body.examples);
    if (examples.error) return json({ error: examples.error }, 400);
    examplesJson = JSON.stringify(examples.list);
  }
  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE eval_datasets SET name = ?1, examples = ?2, updated_at = ?3 WHERE id = ?4 AND org_id = ?5`,
  ).bind(name, examplesJson, now(), id, caller.orgID).run();
  const updated = await loadDataset(env, caller.orgID, id);
  return json(serializeDataset(updated!));
}

async function deleteDataset(env: DashboardEnv, caller: EvalCaller, id: string): Promise<Response> {
  await env.OPENCOMPUTER_DB.prepare(`DELETE FROM eval_datasets WHERE id = ?1 AND org_id = ?2`)
    .bind(id, caller.orgID).run();
  return new Response(null, { status: 204 });
}

// ── runs ─────────────────────────────────────────────────────────────────
async function listRuns(env: DashboardEnv, caller: EvalCaller, datasetId: string): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT * FROM eval_runs WHERE org_id = ?1 AND dataset_id = ?2 ORDER BY created_at DESC LIMIT 50`,
  ).bind(caller.orgID, datasetId).all<RunRow>();
  return json({ data: (results ?? []).map(serializeRun) });
}

async function getRun(env: DashboardEnv, caller: EvalCaller, runId: string): Promise<Response> {
  const run = await env.OPENCOMPUTER_DB.prepare(`SELECT * FROM eval_runs WHERE id = ?1 AND org_id = ?2`)
    .bind(runId, caller.orgID).first<RunRow>();
  if (!run) return json({ error: "run not found" }, 404);
  return json(serializeRun(run));
}

async function listResults(env: DashboardEnv, caller: EvalCaller, runId: string): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT * FROM eval_results WHERE run_id = ?1 AND org_id = ?2 ORDER BY created_at LIMIT 1000`,
  ).bind(runId, caller.orgID).all<ResultRow>();
  return json({ data: (results ?? []).map(serializeResult) });
}

async function createRun(env: DashboardEnv, caller: EvalCaller, ctx: ExecutionContext, datasetId: string): Promise<Response> {
  const dataset = await loadDataset(env, caller.orgID, datasetId);
  if (!dataset) return json({ error: "dataset not found" }, 404);
  const examples = JSON.parse(dataset.examples) as Example[];
  if (examples.length === 0) return json({ error: "dataset has no examples" }, 400);

  const runId = rid("evr"), ts = now();
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO eval_runs (id, org_id, dataset_id, agent_id, status, total, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6)`,
  ).bind(runId, caller.orgID, datasetId, dataset.agent_id, examples.length, ts).run();

  // One result row per example (batched insert).
  const stmts = examples.map((ex) =>
    env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO eval_results (id, run_id, org_id, example_id, input, expect, state, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)`,
    ).bind(rid("evres"), runId, caller.orgID, ex.id, ex.input, JSON.stringify(ex.expect ?? {}), ts),
  );
  await env.OPENCOMPUTER_DB.batch(stmts);

  // Kick the runner now (fast path for small sets); the cron reconciles the rest.
  ctx.waitUntil(advanceRun(env, runId).catch((e) => console.error("evals: advanceRun failed", runId, e)));
  const run = await env.OPENCOMPUTER_DB.prepare(`SELECT * FROM eval_runs WHERE id = ?1`).bind(runId).first<RunRow>();
  return json(serializeRun(run!), 201);
}

// ── runner (resumable state machine) ─────────────────────────────────────────
export async function advanceRun(env: DashboardEnv, runId: string, budgetMs = ADVANCE_BUDGET_MS): Promise<void> {
  const start = Date.now();
  const run = await env.OPENCOMPUTER_DB.prepare(`SELECT * FROM eval_runs WHERE id = ?1`).bind(runId).first<RunRow>();
  if (!run || run.status === "done" || run.status === "failed") return;
  if (!env.OC_ORG_TOKEN_SECRET) { await failRun(env, runId, "agent sessions not configured"); return; }
  if (run.status === "pending") {
    await env.OPENCOMPUTER_DB.prepare(`UPDATE eval_runs SET status = 'running', updated_at = ?2 WHERE id = ?1`)
      .bind(runId, now()).run();
  }

  while (Date.now() - start < budgetMs) {
    const { results } = await env.OPENCOMPUTER_DB.prepare(
      `SELECT * FROM eval_results WHERE run_id = ?1 ORDER BY created_at`,
    ).bind(runId).all<ResultRow>();
    const rows = results ?? [];
    const pending = rows.filter((r) => r.state === "pending");
    const running = rows.filter((r) => r.state === "running");
    if (pending.length === 0 && running.length === 0) break; // all terminal

    await Promise.all(pending.slice(0, START_BATCH).map((r) => startExample(env, run, r)));
    await Promise.all(running.map((r) => pollExample(env, run, r)));
    await updateRunAggregate(env, runId);

    // Everything in flight and nothing to start → let sessions make progress before re-polling.
    if (pending.length <= START_BATCH && running.length > 0) await sleep(1500);
  }
  await updateRunAggregate(env, runId);
}

async function startExample(env: DashboardEnv, run: RunRow, row: ResultRow): Promise<void> {
  try {
    const res = await sessionsFetch(env, run.org_id, "POST", "/v3/sessions", {
      agent: run.agent_id, input: { text: row.input }, metadata: { eval_run: run.id },
    });
    if (!res.ok) throw new Error(`create session HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const session = (await res.json()) as { id?: string; session?: { id?: string } };
    const sessionId = session.id ?? session.session?.id;
    if (!sessionId) throw new Error("create session: no id in response");
    await env.OPENCOMPUTER_DB.prepare(
      `UPDATE eval_results SET state = 'running', session_id = ?2, attempts = attempts + 1, updated_at = ?3 WHERE id = ?1`,
    ).bind(row.id, sessionId, now()).run();
  } catch (e) {
    await bumpOrFail(env, row, e);
  }
}

async function pollExample(env: DashboardEnv, run: RunRow, row: ResultRow): Promise<void> {
  if (!row.session_id) return;
  try {
    const res = await sessionsFetch(env, run.org_id, "GET", `/v3/sessions/${encodeURIComponent(row.session_id)}/result`);
    if (!res.ok) throw new Error(`result HTTP ${res.status}`);
    const body = (await res.json()) as { last_turn?: { state?: string; usage?: Record<string, unknown> }; result?: unknown };
    const state = body.last_turn?.state;
    if (!state || state === "running") return; // still working
    const output = extractText(body.result).slice(0, OUTPUT_CAP);
    const usage = body.last_turn?.usage ?? {};
    const cost = numOf(usage.cost_usd) ?? numOf((usage.cost as Record<string, unknown> | undefined)?.total);
    const tokens = numOf(usage.total_tokens);
    const expect = JSON.parse(row.expect) as Expect;
    let tools: string[] = [];
    if (expect.tools && expect.tools.length) tools = await fetchToolsCalled(env, run.org_id, row.session_id);
    const scores = scoreOutput(expect, { output, outcome: state, cost_usd: cost, tools });
    const passed = scores.every((s) => s.pass) ? 1 : 0;
    await env.OPENCOMPUTER_DB.prepare(
      `UPDATE eval_results SET state = 'done', output = ?2, outcome = ?3, cost_usd = ?4, tokens = ?5,
              scores = ?6, passed = ?7, updated_at = ?8 WHERE id = ?1`,
    ).bind(row.id, output, state, cost ?? null, tokens ?? null, JSON.stringify(scores), passed, now()).run();
  } catch (e) {
    await bumpOrFail(env, row, e);
  }
}

async function bumpOrFail(env: DashboardEnv, row: ResultRow, e: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const msg = e instanceof Error ? e.message : String(e);
  if (attempts >= MAX_ATTEMPTS) {
    await env.OPENCOMPUTER_DB.prepare(
      `UPDATE eval_results SET state = 'failed', attempts = ?2, error = ?3, updated_at = ?4 WHERE id = ?1`,
    ).bind(row.id, attempts, msg.slice(0, 500), now()).run();
  } else {
    await env.OPENCOMPUTER_DB.prepare(
      `UPDATE eval_results SET attempts = ?2, error = ?3, updated_at = ?4 WHERE id = ?1`,
    ).bind(row.id, attempts, msg.slice(0, 500), now()).run();
  }
}

async function updateRunAggregate(env: DashboardEnv, runId: string): Promise<void> {
  const agg = await env.OPENCOMPUTER_DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN state IN ('done','failed') THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed
       FROM eval_results WHERE run_id = ?1`,
  ).bind(runId).first<{ total: number; completed: number; passed: number }>();
  const total = agg?.total ?? 0, completed = agg?.completed ?? 0, passed = agg?.passed ?? 0;
  const allDone = total > 0 && completed >= total;
  const score = completed > 0 ? passed / completed : null;
  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE eval_runs SET completed = ?2, passed = ?3, score = ?4,
            status = CASE WHEN ?5 = 1 THEN 'done' ELSE status END,
            finished_at = CASE WHEN ?5 = 1 THEN ?6 ELSE finished_at END,
            updated_at = ?6 WHERE id = ?1`,
  ).bind(runId, completed, passed, score, allDone ? 1 : 0, now()).run();
}

async function failRun(env: DashboardEnv, runId: string, error: string): Promise<void> {
  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE eval_runs SET status = 'failed', error = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?1`,
  ).bind(runId, error, now()).run();
}

// Cron reconciler: resume any non-terminal run whose rows still have work (5-min tick backstop).
export async function reconcileEvalRuns(env: DashboardEnv): Promise<void> {
  if (!env.OC_ORG_TOKEN_SECRET) return;
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id FROM eval_runs WHERE status IN ('pending','running') ORDER BY updated_at LIMIT 10`,
  ).all<{ id: string }>();
  for (const r of results ?? []) {
    await advanceRun(env, r.id).catch((e) => console.error("evals: reconcile failed", r.id, e));
  }
}

// ── sessions-api access (act for the org) ────────────────────────────────────
async function sessionsFetch(
  env: DashboardEnv, orgId: string, method: string, path: string, body?: unknown,
): Promise<Response> {
  const base = (env.SESSIONS_API_URL ?? "https://api.opencomputer.dev").replace(/\/+$/, "");
  const token = await mintOrgToken(env.OC_ORG_TOKEN_SECRET!, orgId, null);
  const headers: Record<string, string> = { "x-oc-org-token": token };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(base + path, init);
}

async function fetchToolsCalled(env: DashboardEnv, orgId: string, sessionId: string): Promise<string[]> {
  try {
    const res = await sessionsFetch(env, orgId, "GET", `/v3/sessions/${encodeURIComponent(sessionId)}/events?limit=500`);
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ type?: string; body?: { tool?: string } }> };
    return (body.data ?? []).filter((e) => e.type === "tool.call").map((e) => e.body?.tool ?? "").filter(Boolean);
  } catch { return []; }
}

// ── scoring (deterministic; LLM-judge plugs in here later) ───────────────────
export function scoreOutput(
  expect: Expect, obs: { output: string; outcome: string; cost_usd?: number; tools: string[] },
): Score[] {
  const scores: Score[] = [];
  const out = obs.output ?? "";
  const norm = (s: string) => s.trim().toLowerCase();

  scores.push({
    name: "completed",
    pass: obs.outcome !== "error" && obs.outcome !== "failed",
    detail: `turn outcome: ${obs.outcome}`,
  });
  if (expect.contains?.length) {
    const missing = expect.contains.filter((s) => !out.toLowerCase().includes(s.toLowerCase()));
    scores.push({ name: "contains", pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : undefined });
  }
  if (expect.equals !== undefined) {
    scores.push({ name: "equals", pass: norm(out) === norm(expect.equals) });
  }
  if (expect.iregex !== undefined) {
    let pass = false, detail: string | undefined;
    try { pass = new RegExp(expect.iregex, "i").test(out); } catch { detail = "invalid regex"; }
    scores.push({ name: "regex", pass, detail });
  }
  if (expect.outcome !== undefined) {
    scores.push({ name: "outcome", pass: obs.outcome === expect.outcome, detail: `got ${obs.outcome}` });
  }
  if (expect.tools?.length) {
    const missing = expect.tools.filter((t) => !obs.tools.includes(t));
    scores.push({ name: "tools", pass: missing.length === 0, detail: missing.length ? `not called: ${missing.join(", ")}` : undefined });
  }
  if (expect.max_cost_usd !== undefined) {
    const cost = obs.cost_usd ?? 0;
    scores.push({ name: "cost", pass: cost <= expect.max_cost_usd, detail: `$${cost.toFixed(4)} ≤ $${expect.max_cost_usd}` });
  }
  return scores;
}

// ── helpers ──────────────────────────────────────────────────────────────
function loadDataset(env: DashboardEnv, orgId: string, id: string): Promise<DatasetRow | null> {
  return env.OPENCOMPUTER_DB.prepare(`SELECT * FROM eval_datasets WHERE id = ?1 AND org_id = ?2`)
    .bind(id, orgId).first<DatasetRow>();
}

function normalizeExamples(raw: unknown): { list: Example[]; error?: string } {
  if (raw === undefined) return { list: [] };
  if (!Array.isArray(raw)) return { list: [], error: "examples must be an array" };
  if (raw.length > 500) return { list: [], error: "too many examples (max 500)" };
  const list: Example[] = [];
  for (const e of raw) {
    const ex = e as { id?: unknown; input?: unknown; expect?: unknown };
    if (typeof ex.input !== "string" || !ex.input.trim()) return { list: [], error: "each example needs a non-empty input" };
    list.push({
      id: typeof ex.id === "string" && ex.id ? ex.id : rid("ex"),
      input: ex.input,
      ...(ex.expect && typeof ex.expect === "object" ? { expect: ex.expect as Expect } : {}),
    });
  }
  return { list };
}

function extractText(result: unknown): string {
  const body = (result as { body?: unknown } | null | undefined)?.body;
  if (body == null) return "";
  if (typeof body === "string") return body;
  const text = (body as { text?: unknown }).text;
  if (typeof text === "string") return text;
  return JSON.stringify(body);
}
function numOf(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined; }

function serializeDataset(r: DatasetRow) {
  return {
    id: r.id, agent_id: r.agent_id, name: r.name,
    examples: JSON.parse(r.examples) as Example[],
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
function serializeRun(r: RunRow) {
  return {
    id: r.id, dataset_id: r.dataset_id, agent_id: r.agent_id, status: r.status,
    total: r.total, completed: r.completed, passed: r.passed, score: r.score, error: r.error,
    created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at,
  };
}
function serializeResult(r: ResultRow) {
  return {
    id: r.id, run_id: r.run_id, example_id: r.example_id, input: r.input,
    expect: JSON.parse(r.expect) as Expect, state: r.state, session_id: r.session_id,
    output: r.output, outcome: r.outcome, cost_usd: r.cost_usd, tokens: r.tokens,
    scores: JSON.parse(r.scores) as Score[], passed: r.passed, error: r.error,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
