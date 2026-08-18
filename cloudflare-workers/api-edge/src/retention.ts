/**
 * retention.ts — bounded deletion of append-only telemetry.
 *
 * D1 caps a database at 10 GB and there is no way to raise it. `events` and
 * `usage_samples` are append-only and grow ~3.1M rows/day between them, so
 * without this they reach the cap on their own schedule.
 *
 * What that looks like is not "the telemetry tables stop working". Every INSERT
 * in the database fails at once, including the capacity heartbeat, so
 * `cells.capacity_updated_at` freezes; the edge routes on that being fresher
 * than 120s, so within two minutes every create in the region answers
 * "no cells available with capacity" while the cells are perfectly healthy.
 * In-place UPDATEs keep working, which is what makes it confusing: billing
 * watermarks keep advancing while sandbox creation is completely down.
 *
 * That is exactly how prod fell over on 2026-08-17.
 *
 * The sweep runs on the existing five-minute cron and deletes a bounded slice
 * per tick. Bounded rather than "delete everything older than the cutoff": a single
 * unbounded DELETE across millions of rows is the kind of statement that times
 * out, and a sweep that fails is a sweep that does nothing. At the default batch
 * size it removes ~4x the ingest rate, so it converges and then idles.
 */

export interface RetentionEnv {
  OPENCOMPUTER_DB: D1Database;
  /** Days of telemetry to keep. Default 14. */
  TELEMETRY_RETENTION_DAYS?: string;
  /** Rows to delete per table per tick. Default 20000. */
  TELEMETRY_RETENTION_BATCH?: string;
}

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_BATCH = 20_000;

function intFromEnv(v: string | undefined, def: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * runRetentionSweep deletes one bounded batch of aged rows from each telemetry
 * table. Safe to call every tick; a no-op once the tables are inside retention.
 */
export async function runRetentionSweep(env: RetentionEnv): Promise<void> {
  const days = intFromEnv(env.TELEMETRY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const batch = intFromEnv(env.TELEMETRY_RETENTION_BATCH, DEFAULT_BATCH);
  const cutoffMs = Date.now() - days * 86_400_000;

  // events carries no billing meaning — it is the admin/event feed — so the age
  // cutoff is the only constraint.
  await sweep(env, "events", "id", cutoffMs, batch);

  // usage_samples DOES carry billing meaning: the Autumn meter reads it and
  // advances orgs.autumn_usage_watermark past what it has charged for. Deleting
  // a sample the meter has not read yet silently loses revenue, and nothing
  // downstream would ever notice. So the cutoff is the EARLIER of the age
  // cutoff and the least-advanced watermark across all orgs — never delete
  // something no one has billed.
  //
  // Watermarks are stored in SECONDS while ts is milliseconds; conflating the
  // two reads as 1970 and would make this delete everything.
  const wm = await env.OPENCOMPUTER_DB.prepare(
    `SELECT MIN(autumn_usage_watermark) AS wm FROM orgs
      WHERE autumn_usage_watermark IS NOT NULL AND autumn_usage_watermark > 0`,
  ).first<{ wm: number | null }>();

  let sampleCutoffMs = cutoffMs;
  if (wm?.wm) {
    sampleCutoffMs = Math.min(cutoffMs, wm.wm * 1000);
  }
  await sweep(env, "usage_samples", "rowid", sampleCutoffMs, batch);
}

/**
 * sweep deletes up to `limit` rows older than `cutoffMs` from `table`.
 *
 * The subselect on a key column is deliberate: D1 does not support DELETE with
 * a bare LIMIT, so bounding the work means naming the rows first.
 */
async function sweep(
  env: RetentionEnv,
  table: "events" | "usage_samples",
  key: "id" | "rowid",
  cutoffMs: number,
  limit: number,
): Promise<void> {
  try {
    const res = await env.OPENCOMPUTER_DB.prepare(
      `DELETE FROM ${table} WHERE ${key} IN (
         SELECT ${key} FROM ${table} WHERE ts < ?1 LIMIT ?2)`,
    )
      .bind(cutoffMs, limit)
      .run();
    const n = res.meta?.changes ?? 0;
    if (n > 0) console.log(`retention: ${table} deleted ${n} rows older than ${new Date(cutoffMs).toISOString()}`);
  } catch (err) {
    // Never throw: this shares a tick with billing meters, and a retention
    // failure must not take those down with it.
    console.error(`retention: ${table} sweep failed`, err);
  }
}
