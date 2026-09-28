-- feedback.now protocol (https://feedback.now) receiver tables.
--
-- Coding agents that hit our public API discover /.well-known/agent-feedback.json
-- and POST structured bug / friction reports to /api/v1/feedback (or lighter
-- signals to /api/v1/observations). Every submission mints a receipt the agent
-- can poll for triage status. None of this touches sandboxes or cells, so it
-- lives only in D1.
--
-- Timestamps are unix seconds, matching the rest of this schema.

CREATE TABLE agent_feedback (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'open',   -- open|investigating|accepted|resolved|dismissed|spam
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL,
  reproducibility TEXT,
  confidence      REAL NOT NULL,
  surface         TEXT NOT NULL,
  domain          TEXT NOT NULL,
  surface_kind    TEXT,
  product         TEXT,
  title           TEXT NOT NULL,
  summary         TEXT,
  hypothesis      TEXT,
  agent_vendor    TEXT NOT NULL,
  agent_product   TEXT NOT NULL,
  agent_version   TEXT,
  agent_key       TEXT,                           -- base64 SPKI Ed25519 public key when the request was signed
  dedupe_key      TEXT NOT NULL,                  -- sha256(domain|surface|normalized title)
  observations    INTEGER NOT NULL DEFAULT 1,
  quality_score   REAL,
  duplicate_of    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_agent_feedback_status  ON agent_feedback(status, created_at);
CREATE INDEX idx_agent_feedback_dedupe  ON agent_feedback(dedupe_key, created_at);
CREATE INDEX idx_agent_feedback_domain  ON agent_feedback(domain, created_at);

CREATE TABLE agent_feedback_evidence (
  id          TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT NOT NULL,
  redacted    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_agent_feedback_evidence_fb ON agent_feedback_evidence(feedback_id);

CREATE TABLE agent_observations (
  id            TEXT PRIMARY KEY,
  surface       TEXT NOT NULL,
  domain        TEXT NOT NULL,
  category      TEXT,
  severity      TEXT,
  confidence    REAL,
  summary       TEXT,
  agent_vendor  TEXT NOT NULL,
  agent_product TEXT NOT NULL,
  agent_key     TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_agent_observations_surface ON agent_observations(domain, surface, created_at);

CREATE TABLE agent_feedback_receipts (
  id             TEXT PRIMARY KEY,
  feedback_id    TEXT,
  observation_id TEXT,
  status         TEXT NOT NULL,                   -- accepted|needs_more_evidence|duplicate|rejected|queued
  duplicate_of   TEXT,
  agent_key      TEXT,
  client_ip      TEXT,
  created_at     INTEGER NOT NULL
);

-- Rate limiting: submissions per signer / per IP in the trailing hour.
CREATE INDEX idx_agent_feedback_receipts_key ON agent_feedback_receipts(agent_key, created_at);
CREATE INDEX idx_agent_feedback_receipts_ip  ON agent_feedback_receipts(client_ip, created_at);

CREATE TABLE agent_feedback_categories (
  name        TEXT PRIMARY KEY,
  description TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE agent_feedback_agents (
  agent_key     TEXT PRIMARY KEY,
  agent_vendor  TEXT NOT NULL,
  agent_product TEXT NOT NULL,
  submissions   INTEGER NOT NULL DEFAULT 0,
  accepted      INTEGER NOT NULL DEFAULT 0,
  dismissed     INTEGER NOT NULL DEFAULT 0,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);
