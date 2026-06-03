// events-ingest Worker — accepts HMAC-signed event batches from regional CPs.
//
// Pipeline:
//   1. Verify HMAC signature + X-Timestamp freshness (±5 min)
//   2. Parse batch (JSON array of SandboxEvent envelopes)
//   3. D1 batch insert into events table (events.id PRIMARY KEY +
//      ON CONFLICT DO NOTHING is the dedup — KV was redundant and the
//      get() volume blew the daily KV quota, taking down ingest)
//   4. R2 archive raw batch at raw/{cell_id}/{yyyy-mm-dd}/{batch_id}.json.gz
//   5. DO /debit fan-out for free-tier usage_tick events (out-of-band via
//      waitUntil — never blocks the ack so CP forwarder isn't stalled by
//      cross-DO traffic latency)
//   6. Return 202 {accepted}

export interface Env {
  OPENCOMPUTER_DB: D1Database;
  EVENTS_ARCHIVE: R2Bucket;
  CREDIT_ACCOUNT: DurableObjectNamespace;
  EVENT_SECRET: string;
  CF_ADMIN_SECRET: string;
  WORKER_ENV: string;
}

interface SandboxEventEnvelope {
  id: string;
  type: string;
  sandbox_id: string;
  org_id?: string;
  plan?: string;
  worker_id: string;
  cell_id: string;
  payload: unknown;
  timestamp: string;
}

const SIGNATURE_WINDOW_SEC = 5 * 60;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, env: env.WORKER_ENV });
    }

    if (url.pathname !== "/ingest" || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const cellId = req.headers.get("X-Cell-Id") ?? "";
    const tsHeader = req.headers.get("X-Timestamp") ?? "";
    const sigHeader = req.headers.get("X-Signature") ?? "";

    if (!cellId || !tsHeader || !sigHeader) {
      return jsonResponse({ error: "missing signature headers" }, 400);
    }

    // Read raw body once — needed both for signature verification and parsing.
    const bodyText = await req.text();

    const ts = Number.parseInt(tsHeader, 10);
    if (!Number.isFinite(ts)) {
      return jsonResponse({ error: "invalid timestamp" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > SIGNATURE_WINDOW_SEC) {
      return jsonResponse({ error: "timestamp out of window" }, 401);
    }

    const expected = await hmacHex(env.EVENT_SECRET, `${ts}.${bodyText}`);
    if (!constantTimeEqual(expected, sigHeader)) {
      return jsonResponse({ error: "signature mismatch" }, 401);
    }

    let envelopes: SandboxEventEnvelope[];
    try {
      const parsed = JSON.parse(bodyText);
      if (!Array.isArray(parsed)) {
        return jsonResponse({ error: "body must be a JSON array" }, 400);
      }
      envelopes = parsed as SandboxEventEnvelope[];
    } catch (err) {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }
    if (envelopes.length === 0) {
      return jsonResponse({ accepted: 0 }, 202);
    }

    // Dedup is handled by D1: events.id is PRIMARY KEY and the INSERT uses
    // ON CONFLICT(id) DO NOTHING, so replays are silently dropped at the
    // storage layer. We used to also gate behind a KV `seen:{id}` lookup,
    // but the per-request get() spent ~95% of the workers-KV daily cap and
    // ended up failing every single ingest call. Trust D1.
    const fresh = envelopes;

    // D1 batch insert. 11 columns: id, cell_id, type, org_id, sandbox_id,
    // user_id (null for now — not in envelope), worker_id, ts (unix ms), payload.
    const stmt = env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO events (id, cell_id, type, org_id, sandbox_id, user_id, worker_id, ts, payload)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    const batches = fresh.map((e) =>
      stmt.bind(
        e.id,
        e.cell_id,
        e.type,
        e.org_id ?? null,
        e.sandbox_id ?? null,
        e.worker_id ?? null,
        Date.parse(e.timestamp) || Date.now(),
        JSON.stringify(e.payload ?? {}),
      ),
    );

    // cell_capacity events: UPDATE the cells row so api-edge's pickCell() sees
    // fresh placement metrics. The WHERE clause makes the write **monotonic** —
    // stale retries (e.g. an out-of-order XAUTOCLAIM replay of an older event)
    // become no-ops because capacity_updated_at can only move forward in time.
    // Without this guard a stale retry could briefly clobber the row with old
    // values, making the edge cascade-fall-through a cell that's actually fine.
    //
    // Timestamp is the *event emit time* from the CP's envelope, not events-
    // ingest processing time — otherwise the comparison wouldn't be apples-to-
    // apples across retries that arrive at different times.
    const capUpdate = env.OPENCOMPUTER_DB.prepare(
      `UPDATE cells SET healthy_workers = ?1, available_workers = ?2,
                        running_sandboxes = ?3, capacity_updated_at = ?4
         WHERE cell_id = ?5
           AND (capacity_updated_at IS NULL OR capacity_updated_at < ?4)`,
    );

    // Sandbox lifecycle events: keep sandboxes_index in sync with cell-side
    // state changes so the dashboard's cross-cell view is accurate without a
    // separate reconciler. monotonic WHERE clause guards against out-of-order
    // delivery (XAUTOCLAIM replays, network retries) — last_event_at can only
    // move forward.
    //
    // - stopped:    terminal; stamp stopped_at.
    // - hibernated: not terminal; stopped_at stays null so wake works.
    // - running:    create/wake; clear stopped_at to handle the
    //               hibernated → running flip after a wake.
    const lifecycleStopped = env.OPENCOMPUTER_DB.prepare(
      `UPDATE sandboxes_index
          SET status = 'stopped', stopped_at = ?1, last_event_at = ?1
        WHERE id = ?2 AND (last_event_at IS NULL OR last_event_at < ?1)`,
    );
    const lifecycleHibernated = env.OPENCOMPUTER_DB.prepare(
      `UPDATE sandboxes_index
          SET status = 'hibernated', last_event_at = ?1
        WHERE id = ?2 AND (last_event_at IS NULL OR last_event_at < ?1)`,
    );
    // INSERT ON CONFLICT, not plain UPDATE — the previous UPDATE-only shape
    // relied on the api-edge's `ctx.waitUntil` POST /api/sandboxes write to
    // have already created the row. When that waitUntil dropped (CF Worker
    // eviction mid-request, common under batch-create load), the row never
    // existed, this UPDATE no-op'd, and the sandbox stayed invisible in D1
    // until the next lifecycle event also no-op'd. The empirical fingerprint
    // was 34 of 50 still-running sandboxes for one large org being absent
    // from sandboxes_index despite having `created` events in D1 events.
    //
    // With INSERT ON CONFLICT, events-ingest is self-sufficient: every
    // `created` / `running` / `woke` event guarantees the row.
    //
    // Monotonic guard applies only to the UPDATE branch — a newer event
    // wins; an out-of-order older event is ignored. On INSERT (no conflict)
    // the row is created with this event's ts as the high-water mark.
    //
    // Binding order: ?1=tsSec, ?2=sandbox_id, ?3=org_id, ?4=cell_id, ?5=worker_id
    const lifecycleRunning = env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO sandboxes_index (id, org_id, cell_id, worker_id, status, created_at, last_event_at)
       VALUES (?2, ?3, ?4, ?5, 'running', ?1, ?1)
       ON CONFLICT(id) DO UPDATE SET
         status = 'running',
         worker_id = COALESCE(excluded.worker_id, sandboxes_index.worker_id),
         stopped_at = NULL,
         last_event_at = ?1
       WHERE sandboxes_index.last_event_at IS NULL OR sandboxes_index.last_event_at < ?1`,
    );
    // Migration: sandbox moved to a new worker. Update worker_id alongside
    // status so proxyToCellSDK + dashboard reflect the new home immediately
    // (the "created" event on the destination worker would set status but
    // not worker_id otherwise).
    const lifecycleMigrated = env.OPENCOMPUTER_DB.prepare(
      `UPDATE sandboxes_index
          SET status = 'running', worker_id = ?1, stopped_at = NULL, last_event_at = ?2
        WHERE id = ?3 AND (last_event_at IS NULL OR last_event_at < ?2)`,
    );
    const capacityBatches = fresh
      .filter((e) => e.type === "cell_capacity")
      .map((e) => {
        const p = (e.payload ?? {}) as {
          healthy_workers?: number;
          available_workers?: number;
          running_sandboxes?: number;
        };
        const tsMs = Date.parse(e.timestamp) || Date.now();
        const tsSec = Math.floor(tsMs / 1000);
        return capUpdate.bind(
          p.healthy_workers ?? 0,
          p.available_workers ?? 0,
          p.running_sandboxes ?? 0,
          tsSec,
          e.cell_id,
        );
      });

    const lifecycleBatches = fresh
      .filter((e) => e.sandbox_id && (e.type === "stopped" || e.type === "hibernated" || e.type === "running" || e.type === "woke" || e.type === "created" || e.type === "migrated"))
      .map((e) => {
        const tsSec = Math.floor((Date.parse(e.timestamp) || Date.now()) / 1000);
        if (e.type === "stopped") return lifecycleStopped.bind(tsSec, e.sandbox_id);
        if (e.type === "hibernated") return lifecycleHibernated.bind(tsSec, e.sandbox_id);
        if (e.type === "migrated" || e.type === "woke") {
          // worker_id moves with the sandbox. For "migrated" the scaler
          // set the new owner; for "woke" the wake handler set it (a
          // sandbox that hibernated on worker A can wake on worker B
          // after a rolling replace — without this D1 keeps showing A).
          // The CP-side publishSandboxLifecycleEvent uses the envelope's
          // worker_id field rather than payload for these events.
          return lifecycleMigrated.bind(e.worker_id ?? "", tsSec, e.sandbox_id);
        }
        // "running", "created", "woke" set the row to running. Since the
        // INSERT-ON-CONFLICT upgrade, this path also creates the row if the
        // edge's waitUntil dropped on POST /api/sandboxes — events-ingest no
        // longer depends on the edge having written first.
        return lifecycleRunning.bind(
          tsSec,
          e.sandbox_id,
          e.org_id ?? "",
          e.cell_id ?? "",
          e.worker_id ?? null,
        );
      });

    // Checkpoint lifecycle: keep D1 checkpoints_index in sync with cell PG
    // sandbox_checkpoints. CP emits checkpoint_ready after SetCheckpointReady
    // (UPSERT all fields) and checkpoint_deleted after DeleteCheckpoint. The
    // dashboard cross-cell list + the edge's spawn-from-checkpoint routing
    // both depend on this table being populated. golden_hash is write-once:
    // it pins the checkpoint to its base golden, so the upsert fills a
    // previously-empty row but never overwrites a set value — changing it
    // would rebase the delta onto the wrong base and break restore.
    const checkpointUpsert = env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO checkpoints_index
         (id, sandbox_id, org_id, owner_cell_id, s3_url, size_bytes, golden_hash, workspace_size, created_at, name)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         sandbox_id    = excluded.sandbox_id,
         owner_cell_id = excluded.owner_cell_id,
         s3_url        = excluded.s3_url,
         size_bytes    = excluded.size_bytes,
         golden_hash   = CASE WHEN checkpoints_index.golden_hash = '' THEN excluded.golden_hash ELSE checkpoints_index.golden_hash END,
         name          = CASE WHEN excluded.name IS NULL OR excluded.name = '' THEN checkpoints_index.name ELSE excluded.name END`,
    );
    const checkpointDelete = env.OPENCOMPUTER_DB.prepare(
      `DELETE FROM checkpoints_index WHERE id = ?1`,
    );
    const checkpointBatches = fresh
      .filter((e) => e.type === "checkpoint_ready" || e.type === "checkpoint_deleted")
      .flatMap((e) => {
        const p = (e.payload ?? {}) as {
          checkpoint_id?: string;
          rootfs_s3_key?: string;
          workspace_s3_key?: string;
          size_bytes?: number;
          golden_hash?: string;
          name?: string;
        };
        if (!p.checkpoint_id) return [];
        if (e.type === "checkpoint_deleted") {
          return [checkpointDelete.bind(p.checkpoint_id)];
        }
        // checkpoint_ready — use rootfs_s3_key as the canonical s3_url since
        // it's the rootfs delta the worker pulls at spawn time. The workspace
        // key is reachable from the rootfs metadata. `name` is the user-set
        // label; pre-fix the dashboard derived it from rootfs_s3_key, which
        // always ended in "rootfs.tar.zst".
        const tsSec = Math.floor((Date.parse(e.timestamp) || Date.now()) / 1000);
        return [
          checkpointUpsert.bind(
            p.checkpoint_id,
            e.sandbox_id ?? "",
            e.org_id ?? "",
            e.cell_id,
            p.rootfs_s3_key ?? "",
            p.size_bytes ?? null,
            p.golden_hash ?? "",
            tsSec,
            p.name ?? null,
          ),
        ];
      });

    // Image cache lifecycle (analogous to checkpoint lifecycle): CP emits
    // image_cache_ready after a build/snapshot lands in cell PG image_cache,
    // image_cache_deleted on removal. Keeps the dashboard's /api/dashboard/
    // images view in sync without per-cell fan-out.
    const imageUpsert = env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO images_index
         (id, org_id, owner_cell_id, content_hash, checkpoint_id, name, manifest, status, created_at, last_used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(id) DO UPDATE SET
         content_hash  = excluded.content_hash,
         checkpoint_id = excluded.checkpoint_id,
         name          = excluded.name,
         manifest      = excluded.manifest,
         status        = excluded.status,
         last_used_at  = excluded.last_used_at`,
    );
    const imageDelete = env.OPENCOMPUTER_DB.prepare(
      `DELETE FROM images_index WHERE id = ?1`,
    );
    const imageBatches = fresh
      .filter((e) => e.type === "image_cache_ready" || e.type === "image_cache_deleted")
      .flatMap((e) => {
        const p = (e.payload ?? {}) as {
          image_id?: string;
          content_hash?: string;
          checkpoint_id?: string | null;
          name?: string | null;
          manifest?: string;
          status?: string;
          created_at?: number;
          last_used_at?: number;
        };
        if (!p.image_id) return [];
        if (e.type === "image_cache_deleted") {
          return [imageDelete.bind(p.image_id)];
        }
        const ts = Math.floor((Date.parse(e.timestamp) || Date.now()) / 1000);
        return [
          imageUpsert.bind(
            p.image_id,
            e.org_id ?? "",
            e.cell_id,
            p.content_hash ?? "",
            p.checkpoint_id ?? null,
            p.name ?? null,
            p.manifest ?? "{}",
            p.status ?? "ready",
            p.created_at ?? ts,
            p.last_used_at ?? ts,
          ),
        ];
      });

    // Authoritative plan resolution. The envelope's `plan` is the worker's
    // cell-local-PG view, which goes stale on upgrade/downgrade — plan changes
    // globally via the edge, and no single cell has the complete picture. D1
    // orgs.plan is the source of truth and we're already on the edge with D1 in
    // hand, so resolve it here and route by it. Without this, a free→pro upgrade
    // leaks usage: stale 'free' ticks hit the DO (a no-op for a now-pro org) and
    // never get sampled. Falls back to the (stale) envelope plan ONLY if the D1
    // lookup itself fails — degraded, but no worse than trusting it outright.
    const tickOrgIds = [
      ...new Set(fresh.filter((e) => e.type === "usage_tick" && e.org_id).map((e) => e.org_id as string)),
    ];
    const planLookup = await resolvePlans(env, tickOrgIds);
    const planFor = (e: SandboxEventEnvelope): string | undefined =>
      planLookup.ok ? (e.org_id ? planLookup.byOrg.get(e.org_id) : undefined) : e.plan;

    // Pro-tier usage samples: land each pro `usage_tick`'s resource dimensions
    // into usage_samples for the rollup cron (the edge analog of the cell's
    // sandbox_scale_events → billable_events path). Free orgs are debited via
    // the DO fan-out below and need no sample row. id is the event UUID so the
    // ON CONFLICT(id) DO NOTHING dedup matches the events table — the forwarder
    // is at-least-once and additive billing must not double-count on replay.
    //
    // This goes in the main batch (not waitUntil) on purpose: unlike the
    // cross-DO debit fan-out, it's a local D1 write, so it should share the
    // batch's retry-on-failure guarantee (503 → CP forwarder keeps the PEL).
    const usageSampleInsert = env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO usage_samples (id, org_id, sandbox_id, memory_mb, cpu_count, interval_s, ts, cell_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO NOTHING`,
    );
    const usageSampleBatches = fresh
      .filter((e) => e.type === "usage_tick" && planFor(e) === "pro" && e.org_id && e.sandbox_id)
      .map((e) => {
        const p = (e.payload ?? {}) as {
          memory_mb?: number;
          cpu_count?: number;
          interval_s?: number;
        };
        return usageSampleInsert.bind(
          e.id,
          e.org_id,
          e.sandbox_id,
          p.memory_mb ?? 0,
          p.cpu_count ?? 0,
          p.interval_s ?? 0,
          Date.parse(e.timestamp) || Date.now(),
          e.cell_id,
        );
      });

    try {
      await env.OPENCOMPUTER_DB.batch([...batches, ...capacityBatches, ...lifecycleBatches, ...checkpointBatches, ...imageBatches, ...usageSampleBatches]);
    } catch (err) {
      // Database errors are retryable — return 5xx so the CP forwarder
      // leaves the batch in the PEL.
      console.error("events-ingest: D1 batch insert failed", err);
      return jsonResponse({ error: "db insert failed" }, 503);
    }

    // R2 archive — gzipped raw batch. Best effort: archive failure does not
    // block the ack (events are already in D1, which is the durable record).
    try {
      const date = new Date().toISOString().slice(0, 10);
      const batchId = `${ts}-${crypto.randomUUID()}`;
      const key = `raw/${cellId}/${date}/${batchId}.json.gz`;
      const gzipped = await gzip(bodyText);
      await env.EVENTS_ARCHIVE.put(key, gzipped, {
        httpMetadata: { contentType: "application/gzip" },
      });
    } catch (err) {
      console.error("events-ingest: R2 archive failed (continuing)", err);
    }

    // DO /debit fan-out — for free-tier usage_tick events only. Each event
    // routes to a per-org DO instance; we hand off to waitUntil so cross-DO
    // latency never holds the CP forwarder's ack.
    //
    // Pro orgs are filtered here (cheap) rather than in the DO so we avoid
    // even allocating the DO stub for orgs that don't need debit accounting.
    // Plan comes from the authoritative D1 lookup (planFor), not the stale
    // envelope value — so a free→pro upgrade stops debiting immediately and a
    // pro→free downgrade resumes it, with no dependency on cell-PG freshness.
    const debitTargets = fresh.filter((e) => e.type === "usage_tick" && planFor(e) === "free" && e.org_id);
    if (debitTargets.length > 0) {
      ctx.waitUntil(fanoutDebits(env, debitTargets));
    }

    return jsonResponse({ accepted: fresh.length }, 202);
  },
} satisfies ExportedHandler<Env>;

// fanoutDebits dispatches one /debit per usage_tick event to its org's DO.
// Per-event errors are swallowed — DO is idempotent on event_id (LRU dedup)
// so the CP forwarder's automatic retry covers transient DO unavailability
// without risking double-debit.
async function fanoutDebits(env: Env, events: SandboxEventEnvelope[]): Promise<void> {
  await Promise.all(
    events.map(async (e) => {
      try {
        const id = env.CREDIT_ACCOUNT.idFromName(e.org_id!);
        const stub = env.CREDIT_ACCOUNT.get(id);
        const payload = (e.payload ?? {}) as { cost_cents?: number };
        const body = JSON.stringify({
          event_id: e.id,
          amount_cents: payload.cost_cents ?? 0,
        });
        const resp = await stub.fetch(`https://do/debit?org_id=${encodeURIComponent(e.org_id!)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        if (resp.status >= 400) {
          console.error(`events-ingest: DO /debit ${e.org_id} returned ${resp.status} (event ${e.id})`);
        }
      } catch (err) {
        console.error(`events-ingest: DO /debit ${e.org_id} threw`, err);
      }
    }),
  );
}

// resolvePlans fetches the authoritative plan for each org from D1 orgs.plan
// (the global source of truth) in one batched query. Returns ok=false if the
// lookup fails, signalling callers to fall back to the envelope plan rather
// than dropping billing entirely. Orgs absent from D1 (new-org race) are simply
// missing from the map → treated as unknown plan → skipped, the safe default.
async function resolvePlans(
  env: Env,
  orgIds: string[],
): Promise<{ ok: boolean; byOrg: Map<string, string> }> {
  const byOrg = new Map<string, string>();
  if (orgIds.length === 0) return { ok: true, byOrg };
  const placeholders = orgIds.map((_, i) => `?${i + 1}`).join(",");
  try {
    const res = await env.OPENCOMPUTER_DB.prepare(
      `SELECT id, plan FROM orgs WHERE id IN (${placeholders})`,
    )
      .bind(...orgIds)
      .all<{ id: string; plan: string }>();
    for (const r of res.results ?? []) byOrg.set(r.id, r.plan);
    return { ok: true, byOrg };
  } catch (err) {
    console.error("events-ingest: org plan lookup failed — falling back to envelope plan", err);
    return { ok: false, byOrg };
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Returns gzipped bytes as a Uint8Array. R2 requires a known length on
// the body — a raw pipeThrough(CompressionStream) ReadableStream has
// unknown length and trips "Provided readable stream must have a known
// length". Buffering into a Uint8Array gives R2 a length without a
// streaming primitive.
async function gzip(input: string): Promise<Uint8Array> {
  const body = new Response(input).body;
  if (!body) throw new Error("body stream null");
  const compressed = body.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}
