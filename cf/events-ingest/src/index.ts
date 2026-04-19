/**
 * events-ingest Worker
 *
 * POST /ingest receives HMAC-signed event batches from regional control
 * planes and fans them out to D1 (authoritative store), R2 (gzipped raw
 * archive), and KV (dedup via seen:{event_id} with 24h TTL).
 *
 * Auth:
 *   X-Cell-Id:    the sending cell's identifier (e.g. "dev-cell-a")
 *   X-Timestamp:  unix seconds; must be within ±5 min of server clock
 *   X-Signature:  hex HMAC-SHA256 over `${timestamp}.${body}`
 *
 * Response:
 *   202 { accepted, deduped } on success
 *   401 on bad signature / stale timestamp
 *   400 on malformed body
 */

export interface Env {
  OPENCOMPUTER_DB: D1Database;
  SESSIONS_KV: KVNamespace;
  EVENTS_ARCHIVE: R2Bucket;
  EVENT_SECRET: string;
  CREDIT_ACCOUNT: DurableObjectNamespace;
  CF_ADMIN_SECRET: string;
  CELL_ENDPOINTS?: string;
}

// Re-export CreditAccount so Wrangler registers the DO class under the
// migration tag in wrangler.toml. The class itself lives in ../shared so
// the api-edge Worker can import it for its own bindings.
export { CreditAccount } from "../../shared/credit_account";

interface SandboxEvent {
  id: string;
  type: string;
  sandbox_id?: string;
  org_id?: string;
  plan?: string;
  user_id?: string;
  worker_id?: string;
  cell_id: string;
  payload: unknown;
  timestamp: string; // ISO-8601 from Go's time.Time
}

const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname !== "/ingest") {
      return new Response("not found", { status: 404 });
    }

    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    return handleIngest(req, env);
  },
};

async function handleIngest(req: Request, env: Env): Promise<Response> {
  const cellId = req.headers.get("X-Cell-Id") ?? "";
  const ts = req.headers.get("X-Timestamp") ?? "";
  const signature = req.headers.get("X-Signature") ?? "";

  if (!cellId || !ts || !signature) {
    return new Response("missing auth headers", { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > MAX_CLOCK_SKEW_SECONDS) {
    return new Response("timestamp out of window", { status: 401 });
  }

  const body = await req.text();
  const ok = await verifySignature(env.EVENT_SECRET, `${ts}.${body}`, signature);
  if (!ok) {
    return new Response("bad signature", { status: 401 });
  }

  let batch: { events: SandboxEvent[] };
  try {
    batch = JSON.parse(body);
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (!Array.isArray(batch.events)) {
    return new Response("missing events array", { status: 400 });
  }

  const events = batch.events;
  if (events.length === 0) {
    return Response.json({ accepted: 0, deduped: 0 }, { status: 202 });
  }

  // Dedup via KV. Parallel gets; any hit is skipped from the insert list.
  const seenChecks = await Promise.all(
    events.map((e) => env.SESSIONS_KV.get(`seen:${e.id}`)),
  );
  const fresh: SandboxEvent[] = [];
  let deduped = 0;
  for (let i = 0; i < events.length; i++) {
    if (seenChecks[i] != null) {
      deduped++;
    } else {
      fresh.push(events[i]);
    }
  }

  if (fresh.length === 0) {
    return Response.json({ accepted: 0, deduped }, { status: 202 });
  }

  // D1 batch insert. ON CONFLICT skips rows that somehow raced past the KV
  // check (e.g. two ingesters got the same event simultaneously).
  const stmt = env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO events (id, cell_id, type, org_id, sandbox_id, user_id, worker_id, ts, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const batchStmts = fresh.map((e) => {
    const ts = Date.parse(e.timestamp) || Date.now();
    const payload = typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload);
    return stmt.bind(
      e.id,
      cellId,
      e.type,
      e.org_id ?? null,
      e.sandbox_id ?? null,
      e.user_id ?? null,
      e.worker_id ?? null,
      ts,
      payload,
    );
  });
  await env.OPENCOMPUTER_DB.batch(batchStmts);

  // Archive the raw batch to R2. Key format: raw/{cell_id}/{yyyy-mm-dd}/{batch_id}.json.gz
  // Gzip via CompressionStream; small enough payloads that the extra work is cheap.
  const archiveKey = buildArchiveKey(cellId);
  const gz = await gzip(body);
  await env.EVENTS_ARCHIVE.put(archiveKey, gz, {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
  });

  // Mark freshly accepted events as seen so duplicates within 24h dedup fast.
  await Promise.all(
    fresh.map((e) =>
      env.SESSIONS_KV.put(`seen:${e.id}`, "1", { expirationTtl: DEDUP_TTL_SECONDS }),
    ),
  );

  // Side effects: sandboxes_index lifecycle updates + free-tier debits.
  // Runs after the durable writes above so a failure here doesn't lose
  // the raw batch. Errors are logged, not propagated.
  await applyEventSideEffects(env, fresh);

  return Response.json({ accepted: fresh.length, deduped }, { status: 202 });
}

// Per-tier USD/second, mirrored from internal/billing/pricing.go. Unknown tiers
// bill at the 1GB rate to avoid silently zeroing usage — parity with the Go
// side's behavior where missing tiers simply don't contribute.
const TIER_PRICE_PER_SECOND: Record<number, number> = {
  1024: 0.00001080246914,
  4096: 0.00005787037037,
  8192: 0.0001350308642,
  16384: 0.0002700617284,
  32768: 0.001929012346,
  65536: 0.005401234568,
};

async function applyEventSideEffects(env: Env, events: SandboxEvent[]): Promise<void> {
  for (const e of events) {
    try {
      switch (e.type) {
        case "created":
          await indexCreate(env, e);
          break;
        case "destroyed":
          await indexUpdateStatus(env, e, "stopped", true);
          break;
        case "hibernated":
          await indexUpdateStatus(env, e, "hibernated", false);
          break;
        case "woke":
          await indexUpdateStatus(env, e, "running", false);
          break;
        case "usage_tick":
          await handleUsageTick(env, e);
          break;
      }
    } catch (err) {
      console.error(`events-ingest: side effect failed for ${e.type}/${e.id}: ${String(err)}`);
    }
  }
}

async function indexCreate(env: Env, e: SandboxEvent): Promise<void> {
  if (!e.sandbox_id || !e.org_id) return;
  const now = Date.now();
  const payload = typeof e.payload === "object" && e.payload !== null ? (e.payload as Record<string, unknown>) : {};
  const templateId = typeof payload.template_id === "string" ? payload.template_id : null;
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO sandboxes_index (id, org_id, user_id, cell_id, worker_id, status, template_id, created_at, last_event_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       worker_id = excluded.worker_id,
       status = 'running',
       last_event_at = excluded.last_event_at`,
  )
    .bind(e.sandbox_id, e.org_id, e.user_id ?? null, e.cell_id, e.worker_id ?? null, templateId, now, now)
    .run();
}

async function indexUpdateStatus(
  env: Env,
  e: SandboxEvent,
  status: string,
  setStopped: boolean,
): Promise<void> {
  if (!e.sandbox_id) return;
  const now = Date.now();
  if (setStopped) {
    await env.OPENCOMPUTER_DB.prepare(
      `UPDATE sandboxes_index SET status = ?, last_event_at = ?, stopped_at = ? WHERE id = ?`,
    )
      .bind(status, now, now, e.sandbox_id)
      .run();
  } else {
    await env.OPENCOMPUTER_DB.prepare(
      `UPDATE sandboxes_index SET status = ?, last_event_at = ? WHERE id = ?`,
    )
      .bind(status, now, e.sandbox_id)
      .run();
  }
}

async function handleUsageTick(env: Env, e: SandboxEvent): Promise<void> {
  // Only free-tier orgs hit the DO. Pro orgs bill via Stripe Metered already.
  if (e.plan !== "free" || !e.org_id) return;

  const payload = typeof e.payload === "object" && e.payload !== null ? (e.payload as Record<string, unknown>) : {};
  const memoryMB = toNumber(payload.memory_mb);
  const wallSeconds = toNumber(payload.wall_seconds);
  if (memoryMB <= 0 || wallSeconds <= 0) return;

  const rate = TIER_PRICE_PER_SECOND[memoryMB] ?? TIER_PRICE_PER_SECOND[1024];
  const costCents = Math.ceil(wallSeconds * rate * 100);
  if (costCents <= 0) return;

  const stub = env.CREDIT_ACCOUNT.get(env.CREDIT_ACCOUNT.idFromName(e.org_id));
  const resp = await stub.fetch("https://do/debit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      org_id: e.org_id,
      cost_cents: costCents,
      event_id: e.id,
    }),
  });
  if (!resp.ok) {
    console.warn(`events-ingest: DO debit for org ${e.org_id} returned ${resp.status}`);
  }
}

function toNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

async function verifySignature(secret: string, message: string, expectedHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const actualHex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(actualHex, expectedHex);
}

// constantTimeEqual compares two hex strings in fixed time to prevent timing
// attacks on signature verification.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function gzip(s: string): Promise<ArrayBuffer> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

function buildArchiveKey(cellId: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const batchId = crypto.randomUUID();
  return `raw/${cellId}/${y}-${m}-${d}/${batchId}.json.gz`;
}
