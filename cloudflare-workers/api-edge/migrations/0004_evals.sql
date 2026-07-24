-- Native agent evals (input/output). A dataset is a set of {input, expect} examples for one
-- deployed agent; a run executes every example as an isolated session against that agent and
-- scores the output. Runtime-agnostic: the runner drives the /v3 session API, so flue, langgraph,
-- claude, codex and pi are all just "the agent under test". Owned by api-edge + D1 (a consumer of
-- sessions-api, not part of it).

-- A reusable set of {input, expect} examples for a single agent.
CREATE TABLE IF NOT EXISTS eval_datasets (
  id          TEXT PRIMARY KEY,            -- evd_<hex>
  org_id      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,               -- the sessions-api agent id (system under test)
  name        TEXT NOT NULL,
  examples    TEXT NOT NULL DEFAULT '[]',  -- JSON: [{ id, input, expect?: {contains?,equals?,iregex?,tools?,outcome?,max_cost_usd?} }]
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_datasets_org_agent ON eval_datasets (org_id, agent_id, updated_at DESC);

-- One execution of a dataset against the agent (pinned to the live revision at run time).
CREATE TABLE IF NOT EXISTS eval_runs (
  id           TEXT PRIMARY KEY,           -- evr_<hex>
  org_id       TEXT NOT NULL,
  dataset_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  total        INTEGER NOT NULL DEFAULT 0,
  completed    INTEGER NOT NULL DEFAULT 0,        -- results in a terminal state
  passed       INTEGER NOT NULL DEFAULT 0,        -- results with every check passing
  score        REAL,                              -- passed / completed (0..1), null until any complete
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_dataset ON eval_runs (dataset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON eval_runs (status, updated_at);

-- Per-example result within a run. Drives a small state machine (pending -> running -> done/failed)
-- so the cron + a request-time kick can resume it without a Durable Object.
CREATE TABLE IF NOT EXISTS eval_results (
  id          TEXT PRIMARY KEY,            -- evres_<hex>
  run_id      TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  example_id  TEXT NOT NULL,
  input       TEXT NOT NULL,               -- denormalized example input
  expect      TEXT NOT NULL DEFAULT '{}',  -- denormalized example expectations (JSON)
  state       TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed
  session_id  TEXT,                        -- the /v3 session created for this example
  output      TEXT,                        -- final agent message text
  outcome     TEXT,                        -- terminal turn state (ok | error | ...)
  cost_usd    REAL,
  tokens      INTEGER,
  scores      TEXT NOT NULL DEFAULT '[]',  -- JSON: [{ name, pass, detail }]
  passed      INTEGER,                     -- 0/1: every check passed
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_eval_results_state ON eval_results (state, updated_at);
