// feedback.now protocol receiver (https://feedback.now).
//
// Coding agents (Claude Code, Codex, Cursor, ...) that use our API discover
// /.well-known/agent-feedback.json on this host, read the policy, and POST
// structured bug / friction reports. Every submission returns a receipt the
// agent can poll to see how we triaged it. The protocol is SDK-less HTTP, so
// this module is the whole integration: no CP, no cell, D1 only.
//
// Public (agent-facing):
//   GET  /.well-known/agent-feedback.json
//   GET  /api/v1/policy
//   POST /api/v1/feedback
//   POST /api/v1/feedback/:id/attachments
//   POST /api/v1/observations
//   GET  /api/v1/feedback/:id
//   GET  /api/v1/receipts/:id
//   GET  /api/v1/categories
//
// Triage (bearer AGENT_FEEDBACK_TRIAGE_TOKEN):
//   GET    /api/v1/feedback
//   PATCH  /api/v1/feedback/:id
//   DELETE /api/v1/feedback/:id
//   POST   /api/v1/feedback/merge
//   POST   /api/v1/categories
//   GET    /api/v1/agents
//
// Requests may be signed with an Ed25519 key (X-Agent-Key / X-Agent-Signature /
// X-Agent-Timestamp). Signing is optional per the spec; a valid signature ties
// the submission to an agent identity whose reputation we track. An invalid
// signature is rejected — a present-but-wrong signature is a bug worth
// surfacing, not something to silently downgrade to anonymous.

export interface AgentFeedbackEnv {
  OPENCOMPUTER_DB: D1Database;
  AGENT_FEEDBACK_TRIAGE_TOKEN?: string;
}

export const AGENT_FEEDBACK_ROUTE_PREFIX = "/api/v1/";
export const AGENT_FEEDBACK_DISCOVERY_PATH = "/.well-known/agent-feedback.json";

export const CATEGORIES = ["bug", "docs_mismatch", "friction", "feature_gap", "quality_degradation", "other"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const REPRODUCIBILITY = ["always", "sometimes", "intermittent", "once"] as const;
export const SURFACE_KINDS = ["api_endpoint", "docs_page", "cli_command", "sdk_method", "other"] as const;
export const EVIDENCE_TYPES = ["http_summary", "stderr_excerpt", "repro_steps", "screenshot", "log_excerpt", "other"] as const;
export const FEEDBACK_STATUSES = ["open", "investigating", "accepted", "resolved", "dismissed", "spam"] as const;
export const RECEIPT_STATUSES = ["accepted", "needs_more_evidence", "duplicate", "rejected", "queued"] as const;

// Built-in categories plus any custom ones added via POST /api/v1/categories.
type Category = string;
type Severity = (typeof SEVERITIES)[number];
type Reproducibility = (typeof REPRODUCIBILITY)[number];
type SurfaceKind = (typeof SURFACE_KINDS)[number];
type EvidenceType = (typeof EVIDENCE_TYPES)[number];
type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const LIMITS = {
  max_evidence_per_feedback: 10,
  max_evidence_content_bytes: 65536,
  max_title_length: 256,
  max_summary_length: 4096,
  max_hypothesis_length: 2048,
  confidence_range: { min: 0, max: 1 },
} as const;

export const RATE_LIMIT_PER_HOUR = 100;
// Same surface + same normalized title inside this window folds into the
// existing report as another observation instead of a new row.
const DEDUPE_WINDOW_SEC = 30 * 24 * 3600;
const SIGNATURE_SKEW_SEC = 300;

// ── response helpers ─────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorJSON(error: string, message: string, status: number): Response {
  return json({ error, message }, status);
}

interface FieldError {
  field: string;
  error: string;
  message: string;
}

function validationJSON(errors: FieldError[]): Response {
  return json({ error: "validation_failed", errors }, 400);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function newID(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64Decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── discovery + policy ───────────────────────────────────────────────────

export function discoveryDocument(): Record<string, unknown> {
  return {
    schema_version: "1.1",
    name: "OpenComputer",
    description:
      "Agent feedback plane for the OpenComputer sandbox API, SDKs, CLI, and docs. " +
      "Agents submit structured bug reports and friction signals they hit while using OpenComputer.",
    spec_url: "https://docs.opencomputer.dev/api-reference/agent-feedback",
    policy_url: "/api/v1/policy",
    auth: {
      type: "ed25519",
      description: "Sign requests with an Ed25519 keypair for agent identity. Optional but recommended.",
      headers: {
        "X-Agent-Key": "Base64-encoded SPKI DER Ed25519 public key",
        "X-Agent-Signature": "Base64-encoded Ed25519 signature of: timestamp\\nmethod\\npath\\nsha256(body)",
        "X-Agent-Timestamp": "ISO 8601 timestamp (must be within 5 minutes)",
      },
    },
    endpoints: {
      feedback: {
        submit: { method: "POST", url: "/api/v1/feedback", description: "Submit a full structured feedback report with optional evidence." },
        get: { method: "GET", url: "/api/v1/feedback/{id}", description: "Get a single feedback report with evidence." },
        attach_evidence: { method: "POST", url: "/api/v1/feedback/{id}/attachments", description: "Add evidence to an existing feedback report." },
      },
      observations: {
        submit: { method: "POST", url: "/api/v1/observations", description: "Submit a lightweight observation signal." },
      },
      receipts: {
        get: { method: "GET", url: "/api/v1/receipts/{id}", description: "Look up a receipt by ID to check submission and triage status." },
      },
      policy: {
        get: { method: "GET", url: "/api/v1/policy", description: "Get the feedback policy including accepted categories, evidence types, and limits." },
      },
      categories: {
        list: { method: "GET", url: "/api/v1/categories", description: "List available feedback categories." },
      },
    },
    categories: CATEGORIES,
    evidence_types: EVIDENCE_TYPES,
    contact: "https://opencomputer.dev",
  };
}

export function policyDocument(): Record<string, unknown> {
  return {
    version: "1.0",
    categories: CATEGORIES,
    severity_levels: SEVERITIES,
    reproducibility_options: REPRODUCIBILITY,
    evidence_types: EVIDENCE_TYPES,
    surface_kinds: SURFACE_KINDS,
    limits: LIMITS,
    rate_limit_per_hour: RATE_LIMIT_PER_HOUR,
    endpoints: {
      submit_feedback: "/api/v1/feedback",
      submit_observation: "/api/v1/observations",
      get_receipt: "/api/v1/receipts/{id}",
      discovery: AGENT_FEEDBACK_DISCOVERY_PATH,
    },
  };
}

// ── validation ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}

class Validator {
  errors: FieldError[] = [];

  requiredString(obj: Obj, field: string, path: string, max?: number): string | undefined {
    const v = obj[field];
    if (typeof v !== "string" || v.trim() === "") {
      this.errors.push({ field: path, error: "required", message: `${path} is required` });
      return undefined;
    }
    if (max !== undefined && v.length > max) {
      this.errors.push({ field: path, error: "too_long", message: `${path} must be at most ${max} characters` });
      return undefined;
    }
    return v;
  }

  optionalString(obj: Obj, field: string, path: string, max?: number): string | undefined {
    const v = obj[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") {
      this.errors.push({ field: path, error: "invalid_type", message: `${path} must be a string` });
      return undefined;
    }
    if (max !== undefined && v.length > max) {
      this.errors.push({ field: path, error: "too_long", message: `${path} must be at most ${max} characters` });
      return undefined;
    }
    return v;
  }

  enumField<T extends string>(obj: Obj, field: string, path: string, values: readonly T[], required: boolean): T | undefined {
    const v = obj[field];
    if (v === undefined || v === null) {
      if (required) this.errors.push({ field: path, error: "required", message: `${path} is required` });
      return undefined;
    }
    if (!oneOf(values, v)) {
      this.errors.push({ field: path, error: "invalid_enum", message: `${path} must be one of: ${values.join(", ")}` });
      return undefined;
    }
    return v;
  }

  category(obj: Obj, path: string, required: boolean): string | undefined {
    const v = obj.category;
    if (v === undefined || v === null) {
      if (required) this.errors.push({ field: path, error: "required", message: `${path} is required` });
      return undefined;
    }
    if (typeof v !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(v)) {
      this.errors.push({ field: path, error: "invalid_enum", message: `${path} must be one of: ${CATEGORIES.join(", ")} (or a custom category)` });
      return undefined;
    }
    return v;
  }

  confidence(obj: Obj, path: string, required: boolean): number | undefined {
    const v = obj.confidence;
    if (v === undefined || v === null) {
      if (required) this.errors.push({ field: path, error: "required", message: `${path} is required` });
      return undefined;
    }
    if (typeof v !== "number" || Number.isNaN(v) || v < LIMITS.confidence_range.min || v > LIMITS.confidence_range.max) {
      this.errors.push({ field: path, error: "out_of_range", message: `${path} must be a number between 0 and 1` });
      return undefined;
    }
    return v;
  }
}

interface EvidenceIn {
  type: EvidenceType;
  content: string;
  redacted: boolean;
}

function parseEvidenceItem(v: Validator, item: unknown, path: string): EvidenceIn | undefined {
  if (!isObj(item)) {
    v.errors.push({ field: path, error: "invalid_type", message: `${path} must be an object` });
    return undefined;
  }
  const type = v.enumField(item, "type", `${path}.type`, EVIDENCE_TYPES, true);
  const content = item.content;
  if (typeof content !== "string") {
    v.errors.push({ field: `${path}.content`, error: "required", message: `${path}.content is required` });
    return undefined;
  }
  if (new TextEncoder().encode(content).byteLength > LIMITS.max_evidence_content_bytes) {
    v.errors.push({ field: `${path}.content`, error: "too_long", message: `${path}.content exceeds ${LIMITS.max_evidence_content_bytes} bytes` });
    return undefined;
  }
  if (item.redacted !== undefined && typeof item.redacted !== "boolean") {
    v.errors.push({ field: `${path}.redacted`, error: "invalid_type", message: `${path}.redacted must be a boolean` });
    return undefined;
  }
  if (!type) return undefined;
  return { type, content, redacted: item.redacted === true };
}

function parseEvidenceList(v: Validator, raw: unknown, path: string, existing: number): EvidenceIn[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    v.errors.push({ field: path, error: "invalid_type", message: `${path} must be an array` });
    return [];
  }
  if (raw.length + existing > LIMITS.max_evidence_per_feedback) {
    v.errors.push({ field: path, error: "too_many", message: `at most ${LIMITS.max_evidence_per_feedback} evidence items per feedback` });
    return [];
  }
  const out: EvidenceIn[] = [];
  raw.forEach((item, i) => {
    const parsed = parseEvidenceItem(v, item, `${path}[${i}]`);
    if (parsed) out.push(parsed);
  });
  return out;
}

interface FeedbackIn {
  reporter: { agent_vendor: string; agent_product: string; agent_version?: string };
  subject: { surface: string; domain: string; kind?: SurfaceKind; product?: string };
  signal: { category: Category; severity: Severity; reproducibility?: Reproducibility; confidence: number };
  content: { title: string; summary?: string; hypothesis?: string };
  evidence: EvidenceIn[];
}

function parseFeedback(body: unknown): { ok: true; value: FeedbackIn } | { ok: false; errors: FieldError[] } {
  const v = new Validator();
  if (!isObj(body)) return { ok: false, errors: [{ field: "", error: "invalid_type", message: "body must be a JSON object" }] };

  const reporter = isObj(body.reporter) ? body.reporter : undefined;
  const subject = isObj(body.subject) ? body.subject : undefined;
  const signal = isObj(body.signal) ? body.signal : undefined;
  const content = isObj(body.content) ? body.content : undefined;
  for (const [k, present] of [["reporter", reporter], ["subject", subject], ["signal", signal], ["content", content]] as const) {
    if (!present) v.errors.push({ field: k, error: "required", message: `${k} is required` });
  }
  if (!reporter || !subject || !signal || !content) return { ok: false, errors: v.errors };

  const agent_vendor = v.requiredString(reporter, "agent_vendor", "reporter.agent_vendor", 128);
  const agent_product = v.requiredString(reporter, "agent_product", "reporter.agent_product", 128);
  const agent_version = v.optionalString(reporter, "agent_version", "reporter.agent_version", 64);

  const surface = v.requiredString(subject, "surface", "subject.surface", 512);
  const domain = v.requiredString(subject, "domain", "subject.domain", 253);
  const kind = v.enumField(subject, "kind", "subject.kind", SURFACE_KINDS, false);
  const product = v.optionalString(subject, "product", "subject.product", 128);

  const category = v.category(signal, "signal.category", true);
  const severity = v.enumField(signal, "severity", "signal.severity", SEVERITIES, true);
  const reproducibility = v.enumField(signal, "reproducibility", "signal.reproducibility", REPRODUCIBILITY, false);
  const confidence = v.confidence(signal, "signal.confidence", true);

  const title = v.requiredString(content, "title", "content.title", LIMITS.max_title_length);
  const summary = v.optionalString(content, "summary", "content.summary", LIMITS.max_summary_length);
  const hypothesis = v.optionalString(content, "hypothesis", "content.hypothesis", LIMITS.max_hypothesis_length);

  const evidence = parseEvidenceList(v, body.evidence, "evidence", 0);

  if (v.errors.length) return { ok: false, errors: v.errors };
  return {
    ok: true,
    value: {
      reporter: { agent_vendor: agent_vendor!, agent_product: agent_product!, agent_version },
      subject: { surface: surface!, domain: domain!, kind, product },
      signal: { category: category!, severity: severity!, reproducibility, confidence: confidence! },
      content: { title: title!, summary, hypothesis },
      evidence,
    },
  };
}

interface ObservationIn {
  surface: string;
  domain: string;
  agent_vendor: string;
  agent_product: string;
  category?: Category;
  severity?: Severity;
  confidence?: number;
  summary?: string;
}

function parseObservation(body: unknown): { ok: true; value: ObservationIn } | { ok: false; errors: FieldError[] } {
  const v = new Validator();
  if (!isObj(body)) return { ok: false, errors: [{ field: "", error: "invalid_type", message: "body must be a JSON object" }] };
  const surface = v.requiredString(body, "surface", "surface", 512);
  const domain = v.requiredString(body, "domain", "domain", 253);
  const agent_vendor = v.requiredString(body, "agent_vendor", "agent_vendor", 128);
  const agent_product = v.requiredString(body, "agent_product", "agent_product", 128);
  const category = v.category(body, "category", false);
  const severity = v.enumField(body, "severity", "severity", SEVERITIES, false);
  const confidence = v.confidence(body, "confidence", false);
  const summary = v.optionalString(body, "summary", "summary", LIMITS.max_summary_length);
  if (v.errors.length) return { ok: false, errors: v.errors };
  return {
    ok: true,
    value: { surface: surface!, domain: domain!, agent_vendor: agent_vendor!, agent_product: agent_product!, category, severity, confidence, summary },
  };
}

// ── Ed25519 request signing ──────────────────────────────────────────────

type SignatureCheck = { ok: true; agentKey: string | null } | { ok: false; message: string };

// Canonical string per the spec: `timestamp\nmethod\npath\nsha256(body)`,
// with sha256 hex-encoded and path excluding the query string.
export async function signingPayload(timestamp: string, method: string, path: string, body: string): Promise<string> {
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${await sha256Hex(body)}`;
}

async function verifyAgentSignature(req: Request, path: string, body: string): Promise<SignatureCheck> {
  const key = req.headers.get("X-Agent-Key");
  const sig = req.headers.get("X-Agent-Signature");
  const ts = req.headers.get("X-Agent-Timestamp");
  if (!key && !sig && !ts) return { ok: true, agentKey: null };
  if (!key || !sig || !ts) return { ok: false, message: "X-Agent-Key, X-Agent-Signature and X-Agent-Timestamp must be sent together" };

  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return { ok: false, message: "X-Agent-Timestamp must be ISO 8601" };
  if (Math.abs(Date.now() - tsMs) > SIGNATURE_SKEW_SEC * 1000) return { ok: false, message: "X-Agent-Timestamp outside the 5 minute window" };

  const keyDer = b64Decode(key);
  const sigBytes = b64Decode(sig);
  if (!keyDer || !sigBytes) return { ok: false, message: "X-Agent-Key and X-Agent-Signature must be base64" };

  let pub: CryptoKey;
  try {
    pub = await crypto.subtle.importKey("spki", keyDer, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { ok: false, message: "X-Agent-Key is not a SPKI DER Ed25519 public key" };
  }
  const payload = new TextEncoder().encode(await signingPayload(ts, req.method, path, body));
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, pub, sigBytes, payload);
  if (!valid) return { ok: false, message: "X-Agent-Signature does not verify" };
  return { ok: true, agentKey: key };
}

async function categoryAllowed(env: AgentFeedbackEnv, cat: string | undefined, field: string): Promise<FieldError | null> {
  if (cat === undefined || (CATEGORIES as readonly string[]).includes(cat)) return null;
  const row = await env.OPENCOMPUTER_DB.prepare("SELECT name FROM agent_feedback_categories WHERE name = ?1").bind(cat).first<{ name: string }>();
  return row ? null : { field, error: "invalid_enum", message: `unknown category ${cat}` };
}

// ── persistence ──────────────────────────────────────────────────────────

interface FeedbackRow {
  id: string;
  status: FeedbackStatus;
  category: Category;
  severity: Severity;
  reproducibility: Reproducibility | null;
  confidence: number;
  surface: string;
  domain: string;
  surface_kind: SurfaceKind | null;
  product: string | null;
  title: string;
  summary: string | null;
  hypothesis: string | null;
  agent_vendor: string;
  agent_product: string;
  agent_version: string | null;
  agent_key: string | null;
  observations: number;
  quality_score: number | null;
  duplicate_of: string | null;
  created_at: number;
  updated_at: number;
}

interface EvidenceRow {
  id: string;
  type: EvidenceType;
  content: string;
  redacted: number;
  created_at: number;
}

interface ReceiptRow {
  id: string;
  feedback_id: string | null;
  observation_id: string | null;
  status: ReceiptStatus;
  duplicate_of: string | null;
  created_at: number;
}

function feedbackSummary(row: FeedbackRow): Record<string, unknown> {
  return {
    id: row.id,
    reporter: { agent_vendor: row.agent_vendor, agent_product: row.agent_product, agent_version: row.agent_version ?? undefined },
    subject: { surface: row.surface, domain: row.domain, kind: row.surface_kind ?? undefined, product: row.product ?? undefined },
    signal: {
      category: row.category,
      severity: row.severity,
      reproducibility: row.reproducibility ?? undefined,
      confidence: row.confidence,
    },
    content: { title: row.title, summary: row.summary ?? undefined, hypothesis: row.hypothesis ?? undefined },
    status: row.status,
    quality_score: row.quality_score,
    observations: row.observations,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

async function loadFeedbackDetail(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  const row = await db.prepare("SELECT * FROM agent_feedback WHERE id = ?1").bind(id).first<FeedbackRow>();
  if (!row) return null;
  const ev = await db
    .prepare("SELECT id, type, content, redacted, created_at FROM agent_feedback_evidence WHERE feedback_id = ?1 ORDER BY created_at, id")
    .bind(id)
    .all<EvidenceRow>();
  return {
    ...feedbackSummary(row),
    evidence: ev.results.map((e) => ({ id: e.id, type: e.type, content: e.content, redacted: !!e.redacted, created_at: iso(e.created_at) })),
    duplicate_of: row.duplicate_of,
  };
}

function dedupeKeyInput(domain: string, surface: string, title: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(domain)}|${norm(surface)}|${norm(title)}`;
}

function clientIP(req: Request): string | null {
  return req.headers.get("CF-Connecting-IP")?.trim() || null;
}

async function overRateLimit(db: D1Database, agentKey: string | null, ip: string | null): Promise<boolean> {
  const since = nowSec() - 3600;
  const column = agentKey ? "agent_key" : "client_ip";
  const value = agentKey ?? ip;
  if (!value) return false;
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM agent_feedback_receipts WHERE ${column} = ?1 AND created_at > ?2`)
    .bind(value, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= RATE_LIMIT_PER_HOUR;
}

function bumpAgent(db: D1Database, agentKey: string, vendor: string, product: string, ts: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_feedback_agents (agent_key, agent_vendor, agent_product, submissions, accepted, dismissed, first_seen, last_seen)
       VALUES (?1, ?2, ?3, 1, 0, 0, ?4, ?4)
       ON CONFLICT(agent_key) DO UPDATE SET submissions = submissions + 1, last_seen = ?4, agent_vendor = ?2, agent_product = ?3`,
    )
    .bind(agentKey, vendor, product, ts);
}

// ── handlers: public ─────────────────────────────────────────────────────

async function readJSONBody(req: Request): Promise<{ text: string; body: unknown } | Response> {
  const text = await req.text();
  if (text.length > 1_000_000) return errorJSON("payload_too_large", "request body exceeds 1MB", 413);
  try {
    return { text, body: text ? JSON.parse(text) : {} };
  } catch {
    return errorJSON("invalid_json", "request body must be valid JSON", 400);
  }
}

async function submitFeedback(req: Request, env: AgentFeedbackEnv, path: string): Promise<Response> {
  const read = await readJSONBody(req);
  if (read instanceof Response) return read;
  const sig = await verifyAgentSignature(req, path, read.text);
  if (!sig.ok) return errorJSON("invalid_signature", sig.message, 401);

  const parsed = parseFeedback(read.body);
  if (!parsed.ok) return validationJSON(parsed.errors);
  const fb = parsed.value;
  const catErr = await categoryAllowed(env, fb.signal.category, "signal.category");
  if (catErr) return validationJSON([catErr]);

  const db = env.OPENCOMPUTER_DB;
  const ip = clientIP(req);
  if (await overRateLimit(db, sig.agentKey, ip)) return errorJSON("rate_limited", `at most ${RATE_LIMIT_PER_HOUR} submissions per hour`, 429);

  const ts = nowSec();
  const dedupeKey = await sha256Hex(dedupeKeyInput(fb.subject.domain, fb.subject.surface, fb.content.title));
  const existing = await db
    .prepare(
      `SELECT id FROM agent_feedback WHERE dedupe_key = ?1 AND created_at > ?2 AND status NOT IN ('resolved','dismissed','spam') AND duplicate_of IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(dedupeKey, ts - DEDUPE_WINDOW_SEC)
    .first<{ id: string }>();

  const receiptID = newID("rcpt_");
  const stmts: D1PreparedStatement[] = [];
  let feedbackID: string;
  let status: ReceiptStatus;
  let evidenceIDs: string[] = [];

  if (existing) {
    feedbackID = existing.id;
    status = "duplicate";
    stmts.push(db.prepare("UPDATE agent_feedback SET observations = observations + 1, updated_at = ?2 WHERE id = ?1").bind(feedbackID, ts));
  } else {
    feedbackID = newID("fb_");
    status = "accepted";
    stmts.push(
      db
        .prepare(
          `INSERT INTO agent_feedback (id, status, category, severity, reproducibility, confidence, surface, domain, surface_kind, product,
             title, summary, hypothesis, agent_vendor, agent_product, agent_version, agent_key, dedupe_key, observations, created_at, updated_at)
           VALUES (?1, 'open', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1, ?18, ?18)`,
        )
        .bind(
          feedbackID,
          fb.signal.category,
          fb.signal.severity,
          fb.signal.reproducibility ?? null,
          fb.signal.confidence,
          fb.subject.surface,
          fb.subject.domain,
          fb.subject.kind ?? null,
          fb.subject.product ?? null,
          fb.content.title,
          fb.content.summary ?? null,
          fb.content.hypothesis ?? null,
          fb.reporter.agent_vendor,
          fb.reporter.agent_product,
          fb.reporter.agent_version ?? null,
          sig.agentKey,
          dedupeKey,
          ts,
        ),
    );
    evidenceIDs = fb.evidence.map(() => newID("ev_"));
    fb.evidence.forEach((e, i) => {
      stmts.push(
        db
          .prepare("INSERT INTO agent_feedback_evidence (id, feedback_id, type, content, redacted, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
          .bind(evidenceIDs[i], feedbackID, e.type, e.content, e.redacted ? 1 : 0, ts),
      );
    });
  }

  stmts.push(
    db
      .prepare(
        "INSERT INTO agent_feedback_receipts (id, feedback_id, observation_id, status, duplicate_of, agent_key, client_ip, created_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(receiptID, feedbackID, status, existing ? feedbackID : null, sig.agentKey, ip, ts),
  );
  if (sig.agentKey) stmts.push(bumpAgent(db, sig.agentKey, fb.reporter.agent_vendor, fb.reporter.agent_product, ts));
  await db.batch(stmts);

  return json(
    {
      receipt: {
        id: receiptID,
        feedback_id: feedbackID,
        status,
        ...(existing ? { duplicate_of: feedbackID } : {}),
        evidence_ids: evidenceIDs,
        created_at: iso(ts),
      },
    },
    201,
  );
}

async function submitObservation(req: Request, env: AgentFeedbackEnv, path: string): Promise<Response> {
  const read = await readJSONBody(req);
  if (read instanceof Response) return read;
  const sig = await verifyAgentSignature(req, path, read.text);
  if (!sig.ok) return errorJSON("invalid_signature", sig.message, 401);

  const parsed = parseObservation(read.body);
  if (!parsed.ok) return validationJSON(parsed.errors);
  const ob = parsed.value;
  const catErr = await categoryAllowed(env, ob.category, "category");
  if (catErr) return validationJSON([catErr]);

  const db = env.OPENCOMPUTER_DB;
  const ip = clientIP(req);
  if (await overRateLimit(db, sig.agentKey, ip)) return errorJSON("rate_limited", `at most ${RATE_LIMIT_PER_HOUR} submissions per hour`, 429);

  const ts = nowSec();
  const observationID = newID("obs_");
  const receiptID = newID("rcpt_");
  const stmts = [
    db
      .prepare(
        `INSERT INTO agent_observations (id, surface, domain, category, severity, confidence, summary, agent_vendor, agent_product, agent_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        observationID,
        ob.surface,
        ob.domain,
        ob.category ?? null,
        ob.severity ?? null,
        ob.confidence ?? null,
        ob.summary ?? null,
        ob.agent_vendor,
        ob.agent_product,
        sig.agentKey,
        ts,
      ),
    db
      .prepare(
        "INSERT INTO agent_feedback_receipts (id, feedback_id, observation_id, status, duplicate_of, agent_key, client_ip, created_at) VALUES (?1, NULL, ?2, 'accepted', NULL, ?3, ?4, ?5)",
      )
      .bind(receiptID, observationID, sig.agentKey, ip, ts),
  ];
  if (sig.agentKey) stmts.push(bumpAgent(db, sig.agentKey, ob.agent_vendor, ob.agent_product, ts));
  await db.batch(stmts);

  return json({ receipt: { id: receiptID, observation_id: observationID, status: "accepted", created_at: iso(ts) } }, 201);
}

async function attachEvidence(req: Request, env: AgentFeedbackEnv, path: string, id: string): Promise<Response> {
  const read = await readJSONBody(req);
  if (read instanceof Response) return read;
  const sig = await verifyAgentSignature(req, path, read.text);
  if (!sig.ok) return errorJSON("invalid_signature", sig.message, 401);

  const db = env.OPENCOMPUTER_DB;
  const fb = await db.prepare("SELECT id FROM agent_feedback WHERE id = ?1").bind(id).first<{ id: string }>();
  if (!fb) return errorJSON("not_found", "feedback not found", 404);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM agent_feedback_evidence WHERE feedback_id = ?1").bind(id).first<{ n: number }>();

  // EvidenceInput is a single item, `{ evidence: [...] }`, or a bare array.
  const body = read.body;
  let raw: unknown;
  if (Array.isArray(body)) raw = body;
  else if (isObj(body) && Array.isArray(body.evidence)) raw = body.evidence;
  else raw = [body];

  const v = new Validator();
  const items = parseEvidenceList(v, raw, "evidence", count?.n ?? 0);
  if (v.errors.length) return validationJSON(v.errors);
  if (items.length === 0) return validationJSON([{ field: "evidence", error: "required", message: "at least one evidence item is required" }]);

  const ts = nowSec();
  const ids = items.map(() => newID("ev_"));
  const stmts = items.map((e, i) =>
    db
      .prepare("INSERT INTO agent_feedback_evidence (id, feedback_id, type, content, redacted, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(ids[i], id, e.type, e.content, e.redacted ? 1 : 0, ts),
  );
  stmts.push(db.prepare("UPDATE agent_feedback SET updated_at = ?2 WHERE id = ?1").bind(id, ts));
  await db.batch(stmts);
  return json({ data: { feedback_id: id, evidence_ids: ids, created_at: iso(ts) } }, 201);
}

async function getReceipt(env: AgentFeedbackEnv, id: string): Promise<Response> {
  const db = env.OPENCOMPUTER_DB;
  const r = await db.prepare("SELECT id, feedback_id, observation_id, status, duplicate_of, created_at FROM agent_feedback_receipts WHERE id = ?1").bind(id).first<ReceiptRow>();
  if (!r) return errorJSON("not_found", "receipt not found", 404);

  // Reflect triage on the linked feedback so the agent sees the loop close.
  let status: ReceiptStatus = r.status;
  let qualityScore: number | null = null;
  let duplicateOf = r.duplicate_of;
  let feedbackStatus: FeedbackStatus | null = null;
  if (r.feedback_id) {
    const fb = await db
      .prepare("SELECT status, quality_score, duplicate_of FROM agent_feedback WHERE id = ?1")
      .bind(r.feedback_id)
      .first<{ status: FeedbackStatus; quality_score: number | null; duplicate_of: string | null }>();
    if (fb) {
      feedbackStatus = fb.status;
      qualityScore = fb.quality_score;
      if (fb.duplicate_of) {
        status = "duplicate";
        duplicateOf = fb.duplicate_of;
      } else if (fb.status === "dismissed" || fb.status === "spam") {
        status = "rejected";
      } else if (fb.status === "accepted" || fb.status === "resolved") {
        status = "accepted";
      }
    }
  }
  return json({
    data: {
      id: r.id,
      feedback_id: r.feedback_id,
      observation_id: r.observation_id,
      status,
      feedback_status: feedbackStatus,
      quality_score: qualityScore,
      duplicate_of: duplicateOf,
      budget_remaining: null,
      budget_delta: null,
      created_at: iso(r.created_at),
    },
  });
}

async function listCategories(env: AgentFeedbackEnv): Promise<Response> {
  const custom = await env.OPENCOMPUTER_DB.prepare("SELECT name FROM agent_feedback_categories ORDER BY name").all<{ name: string }>();
  return json({ data: [...CATEGORIES, ...custom.results.map((c) => c.name)] });
}

// ── handlers: triage ─────────────────────────────────────────────────────

function triageAuthorized(req: Request, env: AgentFeedbackEnv): boolean {
  const token = env.AGENT_FEEDBACK_TRIAGE_TOKEN;
  if (!token) return false;
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && constantTimeEqual(m[1].trim(), token);
}

async function listFeedback(req: Request, env: AgentFeedbackEnv): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const where: string[] = [];
  const binds: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    binds.push(value);
    where.push(clause.replace("?", `?${binds.length}`));
  };

  const status = q.get("status");
  if (status) {
    if (!oneOf(FEEDBACK_STATUSES, status)) return validationJSON([{ field: "status", error: "invalid_enum", message: `status must be one of: ${FEEDBACK_STATUSES.join(", ")}` }]);
    push("status = ?", status);
  }
  const category = q.get("category");
  if (category) push("category = ?", category);
  const severity = q.get("severity");
  if (severity) {
    if (!oneOf(SEVERITIES, severity)) return validationJSON([{ field: "severity", error: "invalid_enum", message: `severity must be one of: ${SEVERITIES.join(", ")}` }]);
    push("severity = ?", severity);
  }
  const domain = q.get("domain");
  if (domain) push("domain = ?", domain);
  const surface = q.get("surface");
  if (surface) push("surface LIKE ?", `%${surface}%`);
  const text = q.get("q");
  if (text) {
    binds.push(`%${text}%`);
    where.push(`(title LIKE ?${binds.length} OR summary LIKE ?${binds.length})`);
  }

  const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const db = env.OPENCOMPUTER_DB;
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM agent_feedback ${whereSQL}`).bind(...binds).first<{ n: number }>();
  const rows = await db
    .prepare(`SELECT * FROM agent_feedback ${whereSQL} ORDER BY created_at DESC, id DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`)
    .bind(...binds, limit, offset)
    .all<FeedbackRow>();
  return json({
    data: rows.results.map(feedbackSummary),
    meta: { limit, offset, count: rows.results.length, total: total?.n ?? 0 },
  });
}

async function updateFeedback(req: Request, env: AgentFeedbackEnv, id: string): Promise<Response> {
  const read = await readJSONBody(req);
  if (read instanceof Response) return read;
  const body = read.body;
  if (!isObj(body)) return validationJSON([{ field: "", error: "invalid_type", message: "body must be a JSON object" }]);

  const db = env.OPENCOMPUTER_DB;
  const current = await db.prepare("SELECT id, status, agent_key FROM agent_feedback WHERE id = ?1").bind(id).first<{ id: string; status: FeedbackStatus; agent_key: string | null }>();
  if (!current) return errorJSON("not_found", "feedback not found", 404);

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, value: unknown) => {
    binds.push(value);
    sets.push(`${col} = ?${binds.length}`);
  };
  const errors: FieldError[] = [];

  if (body.status !== undefined) {
    if (!oneOf(FEEDBACK_STATUSES, body.status)) errors.push({ field: "status", error: "invalid_enum", message: `status must be one of: ${FEEDBACK_STATUSES.join(", ")}` });
    else set("status", body.status);
  }
  if (body.confirm !== undefined) {
    if (typeof body.confirm !== "boolean") errors.push({ field: "confirm", error: "invalid_type", message: "confirm must be a boolean" });
    else if (body.confirm) sets.push("observations = observations + 1");
  }
  if (body.duplicate_of !== undefined) {
    if (body.duplicate_of === null) set("duplicate_of", null);
    else if (typeof body.duplicate_of !== "string") errors.push({ field: "duplicate_of", error: "invalid_type", message: "duplicate_of must be a feedback ID" });
    else if (body.duplicate_of === id) errors.push({ field: "duplicate_of", error: "invalid", message: "feedback cannot duplicate itself" });
    else {
      const target = await db.prepare("SELECT id FROM agent_feedback WHERE id = ?1").bind(body.duplicate_of).first<{ id: string }>();
      if (!target) errors.push({ field: "duplicate_of", error: "not_found", message: "duplicate_of feedback not found" });
      else set("duplicate_of", body.duplicate_of);
    }
  }
  if (body.quality_score !== undefined) {
    if (body.quality_score === null) set("quality_score", null);
    else if (typeof body.quality_score !== "number" || body.quality_score < 0 || body.quality_score > 1) errors.push({ field: "quality_score", error: "out_of_range", message: "quality_score must be between 0 and 1" });
    else set("quality_score", body.quality_score);
  }
  if (errors.length) return validationJSON(errors);
  if (sets.length === 0) return validationJSON([{ field: "", error: "empty", message: "nothing to update" }]);

  const ts = nowSec();
  set("updated_at", ts);
  binds.push(id);
  const stmts = [db.prepare(`UPDATE agent_feedback SET ${sets.join(", ")} WHERE id = ?${binds.length}`).bind(...binds)];

  // Reputation: count a report once when it first lands in a terminal bucket.
  if (current.agent_key && typeof body.status === "string" && body.status !== current.status) {
    const wasAccepted = current.status === "accepted" || current.status === "resolved";
    const isAccepted = body.status === "accepted" || body.status === "resolved";
    const wasDismissed = current.status === "dismissed" || current.status === "spam";
    const isDismissed = body.status === "dismissed" || body.status === "spam";
    if (isAccepted && !wasAccepted) stmts.push(db.prepare("UPDATE agent_feedback_agents SET accepted = accepted + 1 WHERE agent_key = ?1").bind(current.agent_key));
    if (isDismissed && !wasDismissed) stmts.push(db.prepare("UPDATE agent_feedback_agents SET dismissed = dismissed + 1 WHERE agent_key = ?1").bind(current.agent_key));
  }
  await db.batch(stmts);
  return json({ data: await loadFeedbackDetail(db, id) });
}

async function deleteFeedback(env: AgentFeedbackEnv, id: string): Promise<Response> {
  const db = env.OPENCOMPUTER_DB;
  const current = await db.prepare("SELECT id FROM agent_feedback WHERE id = ?1").bind(id).first<{ id: string }>();
  if (!current) return errorJSON("not_found", "feedback not found", 404);
  await db.batch([
    db.prepare("DELETE FROM agent_feedback_evidence WHERE feedback_id = ?1").bind(id),
    db.prepare("DELETE FROM agent_feedback WHERE id = ?1").bind(id),
  ]);
  return json({ success: true });
}

async function mergeFeedback(req: Request, env: AgentFeedbackEnv): Promise<Response> {
  const read = await readJSONBody(req);
  if (read instanceof Response) return read;
  const body = read.body;
  if (!isObj(body)) return validationJSON([{ field: "", error: "invalid_type", message: "body must be a JSON object" }]);
  const target = body.target_id;
  const sources = body.source_ids;
  const errors: FieldError[] = [];
  if (typeof target !== "string" || !target) errors.push({ field: "target_id", error: "required", message: "target_id is required" });
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every((s) => typeof s === "string")) {
    errors.push({ field: "source_ids", error: "required", message: "source_ids must be a non-empty array of feedback IDs" });
  }
  if (errors.length) return validationJSON(errors);
  const targetID = target as string;
  const sourceIDs = (sources as string[]).filter((s) => s !== targetID);

  const db = env.OPENCOMPUTER_DB;
  const t = await db.prepare("SELECT id FROM agent_feedback WHERE id = ?1").bind(targetID).first<{ id: string }>();
  if (!t) return errorJSON("not_found", "target feedback not found", 404);

  const ts = nowSec();
  const stmts: D1PreparedStatement[] = [];
  for (const src of sourceIDs) {
    const s = await db.prepare("SELECT observations FROM agent_feedback WHERE id = ?1").bind(src).first<{ observations: number }>();
    if (!s) return errorJSON("not_found", `source feedback ${src} not found`, 404);
    stmts.push(
      db.prepare("UPDATE agent_feedback SET observations = observations + ?2, updated_at = ?3 WHERE id = ?1").bind(targetID, s.observations, ts),
      db.prepare("UPDATE agent_feedback SET duplicate_of = ?2, status = 'resolved', updated_at = ?3 WHERE id = ?1").bind(src, targetID, ts),
      db.prepare("UPDATE agent_feedback_evidence SET feedback_id = ?2 WHERE feedback_id = ?1").bind(src, targetID),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return json({ data: await loadFeedbackDetail(db, targetID) });
}

async function createCategory(req: Request, env: AgentFeedbackEnv): Promise<Response> {
  const read = await readJSONBody(req);
  if (read instanceof Response) return read;
  const body = read.body;
  if (!isObj(body)) return validationJSON([{ field: "", error: "invalid_type", message: "body must be a JSON object" }]);
  const name = body.name;
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
    return validationJSON([{ field: "name", error: "invalid", message: "name must be snake_case, 2-64 chars" }]);
  }
  if ((CATEGORIES as readonly string[]).includes(name)) return validationJSON([{ field: "name", error: "exists", message: "category already exists" }]);
  const description = typeof body.description === "string" ? body.description.slice(0, 512) : null;
  await env.OPENCOMPUTER_DB.prepare("INSERT OR IGNORE INTO agent_feedback_categories (name, description, created_at) VALUES (?1, ?2, ?3)")
    .bind(name, description, nowSec())
    .run();
  return json({ data: name }, 201);
}

async function listAgents(env: AgentFeedbackEnv): Promise<Response> {
  const rows = await env.OPENCOMPUTER_DB.prepare("SELECT * FROM agent_feedback_agents ORDER BY last_seen DESC LIMIT 200").all<{
    agent_key: string;
    agent_vendor: string;
    agent_product: string;
    submissions: number;
    accepted: number;
    dismissed: number;
    first_seen: number;
    last_seen: number;
  }>();
  return json({
    data: rows.results.map((a) => ({
      agent_key: a.agent_key,
      agent_vendor: a.agent_vendor,
      agent_product: a.agent_product,
      submissions: a.submissions,
      accepted: a.accepted,
      dismissed: a.dismissed,
      // Laplace-smoothed acceptance rate so a single accepted report isn't a 1.0.
      reputation: (a.accepted + 1) / (a.accepted + a.dismissed + 2),
      first_seen: iso(a.first_seen),
      last_seen: iso(a.last_seen),
    })),
  });
}

// ── router ───────────────────────────────────────────────────────────────

export function isAgentFeedbackPath(path: string): boolean {
  return path === AGENT_FEEDBACK_DISCOVERY_PATH || path.startsWith(AGENT_FEEDBACK_ROUTE_PREFIX);
}

export async function handleAgentFeedback(req: Request, env: AgentFeedbackEnv, path: string): Promise<Response> {
  const method = req.method.toUpperCase();

  if (path === AGENT_FEEDBACK_DISCOVERY_PATH) {
    if (method !== "GET") return errorJSON("method_not_allowed", "GET only", 405);
    return json(discoveryDocument());
  }
  if (path === "/api/v1/policy") {
    if (method !== "GET") return errorJSON("method_not_allowed", "GET only", 405);
    return json(policyDocument());
  }
  if (path === "/api/v1/categories") {
    if (method === "GET") return listCategories(env);
    if (method === "POST") return triageAuthorized(req, env) ? createCategory(req, env) : errorJSON("unauthorized", "triage token required", 401);
    return errorJSON("method_not_allowed", "GET or POST", 405);
  }
  if (path === "/api/v1/observations") {
    if (method !== "POST") return errorJSON("method_not_allowed", "POST only", 405);
    return submitObservation(req, env, path);
  }
  if (path === "/api/v1/feedback") {
    if (method === "POST") return submitFeedback(req, env, path);
    if (method === "GET") return triageAuthorized(req, env) ? listFeedback(req, env) : errorJSON("unauthorized", "triage token required", 401);
    return errorJSON("method_not_allowed", "GET or POST", 405);
  }
  if (path === "/api/v1/feedback/merge") {
    if (method !== "POST") return errorJSON("method_not_allowed", "POST only", 405);
    return triageAuthorized(req, env) ? mergeFeedback(req, env) : errorJSON("unauthorized", "triage token required", 401);
  }
  if (path === "/api/v1/agents") {
    if (method !== "GET") return errorJSON("method_not_allowed", "GET only", 405);
    return triageAuthorized(req, env) ? listAgents(env) : errorJSON("unauthorized", "triage token required", 401);
  }

  let m = path.match(/^\/api\/v1\/receipts\/([A-Za-z0-9_-]+)$/);
  if (m) {
    if (method !== "GET") return errorJSON("method_not_allowed", "GET only", 405);
    return getReceipt(env, m[1]);
  }
  m = path.match(/^\/api\/v1\/feedback\/([A-Za-z0-9_-]+)\/attachments$/);
  if (m) {
    if (method !== "POST") return errorJSON("method_not_allowed", "POST only", 405);
    return attachEvidence(req, env, path, m[1]);
  }
  m = path.match(/^\/api\/v1\/feedback\/([A-Za-z0-9_-]+)$/);
  if (m) {
    if (method === "GET") {
      const detail = await loadFeedbackDetail(env.OPENCOMPUTER_DB, m[1]);
      return detail ? json({ data: detail }) : errorJSON("not_found", "feedback not found", 404);
    }
    if (!triageAuthorized(req, env)) return errorJSON("unauthorized", "triage token required", 401);
    if (method === "PATCH") return updateFeedback(req, env, m[1]);
    if (method === "DELETE") return deleteFeedback(env, m[1]);
    return errorJSON("method_not_allowed", "GET, PATCH or DELETE", 405);
  }

  return errorJSON("not_found", "no such route", 404);
}

