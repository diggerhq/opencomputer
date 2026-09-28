import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_FEEDBACK_DISCOVERY_PATH,
  handleAgentFeedback,
  isAgentFeedbackPath,
  signingPayload,
  type AgentFeedbackEnv,
} from "./agent_feedback";

// The tsconfig is workers-only (no @types/node), and vite's resolver doesn't
// know node:sqlite, so reach the Node 22 builtins via process.getBuiltinModule
// with minimal local typings. Running the module's SQL against the real
// migration beats a hand-rolled D1 fake.
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
declare const process: { cwd(): string; getBuiltinModule(id: string): unknown };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
const { readFileSync } = process.getBuiltinModule("node:fs") as { readFileSync(path: string, enc: "utf8"): string };

class Stmt {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...p: unknown[]): this {
    this.params = p;
    return this;
  }
  // node:sqlite supports ?NNN positional params natively; D1 uses the same form.
  private args(): unknown[] {
    return this.params.map((v) => (v === undefined ? null : v));
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[] };
  }
  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...this.args());
    return { success: true };
  }
}

function makeEnv(triageToken?: string): AgentFeedbackEnv {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(process.cwd() + "/migrations/0008_agent_feedback.sql", "utf8"));
  return {
    OPENCOMPUTER_DB: {
      prepare: (sql: string) => new Stmt(db, sql),
      batch: async (stmts: Stmt[]) => {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        return out;
      },
    } as unknown as D1Database,
    AGENT_FEEDBACK_TRIAGE_TOKEN: triageToken,
  };
}

const HOST = "https://app.test";

function call(env: AgentFeedbackEnv, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request(HOST + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return handleAgentFeedback(req, env, new URL(req.url).pathname);
}

const validFeedback = {
  reporter: { agent_vendor: "anthropic", agent_product: "claude-code", agent_version: "1.2.3" },
  subject: { surface: "POST /api/sandboxes", domain: "app.opencomputer.dev", kind: "api_endpoint" },
  signal: { category: "bug", severity: "high", reproducibility: "always", confidence: 0.9 },
  content: { title: "create returns 500 when template missing", summary: "Expected 404 with a clear error." },
  evidence: [{ type: "http_summary", content: JSON.stringify({ status: 500 }) }],
};

let env: AgentFeedbackEnv;
beforeEach(() => {
  env = makeEnv("triage-secret");
});

describe("routing", () => {
  it("claims the discovery path and /api/v1/*, nothing else", () => {
    expect(isAgentFeedbackPath(AGENT_FEEDBACK_DISCOVERY_PATH)).toBe(true);
    expect(isAgentFeedbackPath("/api/v1/feedback")).toBe(true);
    expect(isAgentFeedbackPath("/api/sandboxes")).toBe(false);
    expect(isAgentFeedbackPath("/api/dashboard/me")).toBe(false);
    expect(isAgentFeedbackPath("/.well-known/other.json")).toBe(false);
  });

  it("serves discovery + policy with the spec's shape", async () => {
    const disc = await (await call(env, "GET", AGENT_FEEDBACK_DISCOVERY_PATH)).json() as Record<string, unknown>;
    expect(disc.schema_version).toBe("1.1");
    expect(disc.policy_url).toBe("/api/v1/policy");
    expect((disc.endpoints as Record<string, Record<string, Record<string, string>>>).feedback.submit.url).toBe("/api/v1/feedback");

    const pol = await (await call(env, "GET", "/api/v1/policy")).json() as Record<string, unknown>;
    expect(pol.categories).toContain("bug");
    expect(pol.severity_levels).toEqual(["critical", "high", "medium", "low"]);
    expect((pol.limits as Record<string, number>).max_evidence_per_feedback).toBe(10);
    expect((pol.endpoints as Record<string, string>).discovery).toBe(AGENT_FEEDBACK_DISCOVERY_PATH);
  });

  it("404s unknown /api/v1 routes", async () => {
    expect((await call(env, "GET", "/api/v1/nope")).status).toBe(404);
  });
});

describe("submit feedback", () => {
  it("accepts a valid report, stores evidence, and mints a pollable receipt", async () => {
    const res = await call(env, "POST", "/api/v1/feedback", validFeedback);
    expect(res.status).toBe(201);
    const { receipt } = await res.json() as { receipt: Record<string, unknown> };
    expect(receipt.status).toBe("accepted");
    expect(String(receipt.feedback_id)).toMatch(/^fb_/);
    expect(receipt.evidence_ids).toHaveLength(1);

    const rcpt = await (await call(env, "GET", `/api/v1/receipts/${receipt.id}`)).json() as { data: Record<string, unknown> };
    expect(rcpt.data.status).toBe("accepted");
    expect(rcpt.data.feedback_id).toBe(receipt.feedback_id);
    expect(rcpt.data.feedback_status).toBe("open");

    const detail = await (await call(env, "GET", `/api/v1/feedback/${receipt.feedback_id}`)).json() as { data: Record<string, unknown> };
    expect(detail.data.status).toBe("open");
    expect(detail.data.observations).toBe(1);
    expect((detail.data.evidence as unknown[]).length).toBe(1);
    expect((detail.data.content as Record<string, string>).title).toBe(validFeedback.content.title);
  });

  it("returns the spec's validation error shape", async () => {
    const res = await call(env, "POST", "/api/v1/feedback", {
      reporter: { agent_vendor: "x" },
      subject: { surface: "s", domain: "d" },
      signal: { category: "nonsense!", severity: "loud", confidence: 7 },
      content: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; errors: { field: string; error: string }[] };
    expect(body.error).toBe("validation_failed");
    const fields = body.errors.map((e) => e.field).sort();
    expect(fields).toEqual(["content.title", "reporter.agent_product", "signal.category", "signal.confidence", "signal.severity"]);
  });

  it("rejects unknown categories but accepts custom ones once created", async () => {
    const custom = { ...validFeedback, signal: { ...validFeedback.signal, category: "billing_confusion" } };
    expect((await call(env, "POST", "/api/v1/feedback", custom)).status).toBe(400);

    const created = await call(env, "POST", "/api/v1/categories", { name: "billing_confusion" }, { authorization: "Bearer triage-secret" });
    expect(created.status).toBe(201);
    expect((await call(env, "POST", "/api/v1/feedback", custom)).status).toBe(201);
    const cats = await (await call(env, "GET", "/api/v1/categories")).json() as { data: string[] };
    expect(cats.data).toContain("billing_confusion");
  });

  it("folds a repeat of the same surface+title into the existing report", async () => {
    const first = (await (await call(env, "POST", "/api/v1/feedback", validFeedback)).json() as { receipt: Record<string, string> }).receipt;
    const again = { ...validFeedback, content: { title: validFeedback.content.title.toUpperCase() + "  " } };
    const res = await call(env, "POST", "/api/v1/feedback", again);
    expect(res.status).toBe(201);
    const { receipt } = await res.json() as { receipt: Record<string, unknown> };
    expect(receipt.status).toBe("duplicate");
    expect(receipt.feedback_id).toBe(first.feedback_id);
    expect(receipt.duplicate_of).toBe(first.feedback_id);

    const detail = await (await call(env, "GET", `/api/v1/feedback/${first.feedback_id}`)).json() as { data: Record<string, unknown> };
    expect(detail.data.observations).toBe(2);
  });

  it("rejects malformed JSON and non-object bodies", async () => {
    expect((await call(env, "POST", "/api/v1/feedback", "{not json")).status).toBe(400);
    expect((await call(env, "POST", "/api/v1/feedback", [1, 2])).status).toBe(400);
  });

  it("rate limits per client IP after 100 submissions in an hour", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 100; i++) {
      const r = await call(env, "POST", "/api/v1/observations", { surface: `s${i}`, domain: "d", agent_vendor: "v", agent_product: "p" }, ip);
      expect(r.status).toBe(201);
    }
    const blocked = await call(env, "POST", "/api/v1/observations", { surface: "s", domain: "d", agent_vendor: "v", agent_product: "p" }, ip);
    expect(blocked.status).toBe(429);
    const other = await call(env, "POST", "/api/v1/observations", { surface: "s", domain: "d", agent_vendor: "v", agent_product: "p" }, { "cf-connecting-ip": "203.0.113.8" });
    expect(other.status).toBe(201);
  });
});

describe("observations", () => {
  it("accepts a lightweight signal and mints a receipt", async () => {
    const res = await call(env, "POST", "/api/v1/observations", {
      surface: "oc sandbox create",
      domain: "app.opencomputer.dev",
      agent_vendor: "openai",
      agent_product: "codex",
      category: "friction",
      severity: "low",
      confidence: 0.4,
      summary: "flag name differs from docs",
    });
    expect(res.status).toBe(201);
    const { receipt } = await res.json() as { receipt: Record<string, string> };
    expect(receipt.observation_id).toMatch(/^obs_/);
    const rcpt = await (await call(env, "GET", `/api/v1/receipts/${receipt.id}`)).json() as { data: Record<string, unknown> };
    expect(rcpt.data.observation_id).toBe(receipt.observation_id);
    expect(rcpt.data.feedback_id).toBeNull();
  });

  it("requires the four mandatory fields", async () => {
    const res = await call(env, "POST", "/api/v1/observations", { surface: "s" });
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: { field: string }[] };
    expect(body.errors.map((e) => e.field).sort()).toEqual(["agent_product", "agent_vendor", "domain"]);
  });
});

describe("evidence attachments", () => {
  async function submit(): Promise<string> {
    const r = await call(env, "POST", "/api/v1/feedback", validFeedback);
    return ((await r.json()) as { receipt: { feedback_id: string } }).receipt.feedback_id;
  }

  it("accepts a single item, an array, or {evidence:[...]}", async () => {
    const id = await submit();
    const single = await call(env, "POST", `/api/v1/feedback/${id}/attachments`, { type: "log_excerpt", content: "boom" });
    expect(single.status).toBe(201);
    const arr = await call(env, "POST", `/api/v1/feedback/${id}/attachments`, [{ type: "repro_steps", content: "1. run" }]);
    expect(arr.status).toBe(201);
    const wrapped = await call(env, "POST", `/api/v1/feedback/${id}/attachments`, { evidence: [{ type: "other", content: "x", redacted: true }] });
    expect(wrapped.status).toBe(201);
    const detail = await (await call(env, "GET", `/api/v1/feedback/${id}`)).json() as { data: { evidence: { redacted: boolean }[] } };
    expect(detail.data.evidence).toHaveLength(4);
    expect(detail.data.evidence.filter((e) => e.redacted)).toHaveLength(1);
  });

  it("enforces the 10-item ceiling across the whole report", async () => {
    const id = await submit();
    const nine = Array.from({ length: 9 }, () => ({ type: "other", content: "x" }));
    expect((await call(env, "POST", `/api/v1/feedback/${id}/attachments`, nine)).status).toBe(201);
    const over = await call(env, "POST", `/api/v1/feedback/${id}/attachments`, { type: "other", content: "one too many" });
    expect(over.status).toBe(400);
  });

  it("404s an unknown feedback id", async () => {
    expect((await call(env, "POST", "/api/v1/feedback/fb_missing/attachments", { type: "other", content: "x" })).status).toBe(404);
  });
});

describe("Ed25519 signing", () => {
  async function signed(body: unknown, path: string, tamper?: (h: Record<string, string>) => void): Promise<Response> {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", kp.publicKey)) as ArrayBuffer);
    const text = JSON.stringify(body);
    const ts = new Date().toISOString();
    const payload = new TextEncoder().encode(await signingPayload(ts, "POST", path, text));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, payload));
    const headers: Record<string, string> = {
      "X-Agent-Key": btoa(String.fromCharCode(...spki)),
      "X-Agent-Signature": btoa(String.fromCharCode(...sig)),
      "X-Agent-Timestamp": ts,
    };
    tamper?.(headers);
    return call(env, "POST", path, text, headers);
  }

  it("accepts a correctly signed submission and tracks the agent", async () => {
    const res = await signed(validFeedback, "/api/v1/feedback");
    expect(res.status).toBe(201);
    const agents = await (await call(env, "GET", "/api/v1/agents", undefined, { authorization: "Bearer triage-secret" })).json() as { data: Record<string, unknown>[] };
    expect(agents.data).toHaveLength(1);
    expect(agents.data[0].submissions).toBe(1);
    expect(agents.data[0].agent_product).toBe("claude-code");
  });

  it("rejects a tampered signature and a stale timestamp", async () => {
    const bad = await signed(validFeedback, "/api/v1/feedback", (h) => { h["X-Agent-Signature"] = h["X-Agent-Signature"].replace(/^./, (c) => (c === "A" ? "B" : "A")); });
    expect(bad.status).toBe(401);
    const stale = await signed(validFeedback, "/api/v1/feedback", (h) => { h["X-Agent-Timestamp"] = new Date(Date.now() - 3600_000).toISOString(); });
    expect(stale.status).toBe(401);
    const partial = await signed(validFeedback, "/api/v1/feedback", (h) => { delete h["X-Agent-Key"]; });
    expect(partial.status).toBe(401);
  });
});

describe("triage", () => {
  const auth = { authorization: "Bearer triage-secret" };

  async function submit(title: string): Promise<{ feedback_id: string; receipt_id: string }> {
    const r = await call(env, "POST", "/api/v1/feedback", { ...validFeedback, content: { title } });
    const { receipt } = (await r.json()) as { receipt: { id: string; feedback_id: string } };
    return { feedback_id: receipt.feedback_id, receipt_id: receipt.id };
  }

  it("gates list/patch/delete/merge/agents behind the bearer token", async () => {
    const { feedback_id } = await submit("a");
    expect((await call(env, "GET", "/api/v1/feedback")).status).toBe(401);
    expect((await call(env, "PATCH", `/api/v1/feedback/${feedback_id}`, { status: "accepted" })).status).toBe(401);
    expect((await call(env, "DELETE", `/api/v1/feedback/${feedback_id}`)).status).toBe(401);
    expect((await call(env, "POST", "/api/v1/feedback/merge", { target_id: feedback_id, source_ids: [] })).status).toBe(401);
    expect((await call(env, "GET", "/api/v1/agents")).status).toBe(401);
    expect((await call(env, "GET", "/api/v1/feedback", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("is disabled entirely when no token is configured", async () => {
    const noTriage = makeEnv(undefined);
    expect((await call(noTriage, "GET", "/api/v1/feedback", undefined, { authorization: "Bearer " })).status).toBe(401);
    expect((await call(noTriage, "POST", "/api/v1/feedback", validFeedback)).status).toBe(201);
  });

  it("lists with filters and pagination", async () => {
    await submit("alpha");
    await submit("beta");
    const r = await call(env, "POST", "/api/v1/feedback", { ...validFeedback, signal: { ...validFeedback.signal, severity: "low" }, content: { title: "gamma" } });
    expect(r.status).toBe(201);

    const all = await (await call(env, "GET", "/api/v1/feedback?limit=2", undefined, auth)).json() as { data: unknown[]; meta: Record<string, number> };
    expect(all.data).toHaveLength(2);
    expect(all.meta.total).toBe(3);
    expect(all.meta.limit).toBe(2);

    const low = await (await call(env, "GET", "/api/v1/feedback?severity=low", undefined, auth)).json() as { data: { content: { title: string } }[] };
    expect(low.data.map((d) => d.content.title)).toEqual(["gamma"]);

    const q = await (await call(env, "GET", "/api/v1/feedback?q=alph", undefined, auth)).json() as { data: unknown[] };
    expect(q.data).toHaveLength(1);

    expect((await call(env, "GET", "/api/v1/feedback?status=bogus", undefined, auth)).status).toBe(400);
  });

  it("patches status/quality/duplicate and reflects it in the receipt", async () => {
    const a = await submit("a");
    const b = await submit("b");

    const res = await call(env, "PATCH", `/api/v1/feedback/${a.feedback_id}`, { status: "accepted", quality_score: 0.8, confirm: true }, auth);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, unknown> };
    expect(data.status).toBe("accepted");
    expect(data.quality_score).toBe(0.8);
    expect(data.observations).toBe(2);

    const rcptA = await (await call(env, "GET", `/api/v1/receipts/${a.receipt_id}`)).json() as { data: Record<string, unknown> };
    expect(rcptA.data.status).toBe("accepted");
    expect(rcptA.data.quality_score).toBe(0.8);

    await call(env, "PATCH", `/api/v1/feedback/${b.feedback_id}`, { duplicate_of: a.feedback_id }, auth);
    const rcptB = await (await call(env, "GET", `/api/v1/receipts/${b.receipt_id}`)).json() as { data: Record<string, unknown> };
    expect(rcptB.data.status).toBe("duplicate");
    expect(rcptB.data.duplicate_of).toBe(a.feedback_id);

    await call(env, "PATCH", `/api/v1/feedback/${b.feedback_id}`, { status: "spam" }, auth);
    const rejected = await (await call(env, "GET", `/api/v1/receipts/${b.receipt_id}`)).json() as { data: Record<string, unknown> };
    // duplicate_of wins over dismissal so the agent is pointed at the canonical report
    expect(rejected.data.status).toBe("duplicate");

    expect((await call(env, "PATCH", `/api/v1/feedback/${a.feedback_id}`, { duplicate_of: a.feedback_id }, auth)).status).toBe(400);
    expect((await call(env, "PATCH", `/api/v1/feedback/${a.feedback_id}`, { quality_score: 3 }, auth)).status).toBe(400);
    expect((await call(env, "PATCH", `/api/v1/feedback/${a.feedback_id}`, {}, auth)).status).toBe(400);
    expect((await call(env, "PATCH", "/api/v1/feedback/fb_missing", { status: "open" }, auth)).status).toBe(404);
  });

  it("merges sources into a target, moving evidence and observations", async () => {
    const a = await submit("a");
    const b = await submit("b");
    const res = await call(env, "POST", "/api/v1/feedback/merge", { target_id: a.feedback_id, source_ids: [b.feedback_id] }, auth);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, unknown> };
    expect(data.observations).toBe(2);
    expect((data.evidence as unknown[]).length).toBe(2);

    const bDetail = await (await call(env, "GET", `/api/v1/feedback/${b.feedback_id}`)).json() as { data: Record<string, unknown> };
    expect(bDetail.data.duplicate_of).toBe(a.feedback_id);
    expect(bDetail.data.status).toBe("resolved");

    expect((await call(env, "POST", "/api/v1/feedback/merge", { target_id: "fb_missing", source_ids: [b.feedback_id] }, auth)).status).toBe(404);
    expect((await call(env, "POST", "/api/v1/feedback/merge", { target_id: a.feedback_id }, auth)).status).toBe(400);
  });

  it("deletes a report with its evidence", async () => {
    const a = await submit("a");
    expect((await call(env, "DELETE", `/api/v1/feedback/${a.feedback_id}`, undefined, auth)).status).toBe(200);
    expect((await call(env, "GET", `/api/v1/feedback/${a.feedback_id}`)).status).toBe(404);
    expect((await call(env, "DELETE", `/api/v1/feedback/${a.feedback_id}`, undefined, auth)).status).toBe(404);
  });

  it("validates custom category names", async () => {
    expect((await call(env, "POST", "/api/v1/categories", { name: "Bad Name" }, auth)).status).toBe(400);
    expect((await call(env, "POST", "/api/v1/categories", { name: "bug" }, auth)).status).toBe(400);
  });
});
