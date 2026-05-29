// Edge-native snapshot + image reads. Snapshots and images are both backed by
// the cell's image_cache table, mirrored into D1's images_index by the
// events-ingest worker (image_cache_ready / image_cache_deleted events).
// A "snapshot" is just a *named* image. Because D1 is the global source of
// truth, the edge serves list/get directly — no cell round-trip, works across
// any number of cells, and survives an owning-cell outage.
//
// Create + delete are cell-work (build bytes / delete bytes) and route to a
// cell via proxyToCellAuthed in index.ts.

export interface SnapshotsEnv {
  OPENCOMPUTER_DB: D1Database;
}

interface Caller {
  orgID: string;
  userID: string | null;
}

interface ImageRow {
  id: string;
  org_id: string;
  owner_cell_id: string;
  content_hash: string;
  checkpoint_id: string | null;
  name: string | null;
  manifest: string | null;
  status: string;
  created_at: number;
  last_used_at: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// rowToJSON maps an images_index row to the shape the TS/Python SDKs unmarshal
// (SnapshotInfo / ImageCacheItem) — camelCase, ISO timestamps, parsed manifest.
function rowToJSON(r: ImageRow): Record<string, unknown> {
  let manifest: unknown = {};
  if (r.manifest) {
    try { manifest = JSON.parse(r.manifest); } catch { /* leave {} */ }
  }
  return {
    id: r.id,
    orgId: r.org_id,
    cellId: r.owner_cell_id,
    contentHash: r.content_hash,
    checkpointId: r.checkpoint_id ?? undefined,
    name: r.name ?? undefined,
    manifest,
    status: r.status,
    createdAt: new Date(r.created_at * 1000).toISOString(),
    lastUsedAt: new Date(r.last_used_at * 1000).toISOString(),
  };
}

const SELECT_COLS =
  "id, org_id, owner_cell_id, content_hash, checkpoint_id, name, manifest, status, created_at, last_used_at";

// GET /api/snapshots — named images only (a snapshot is a named image).
export async function listSnapshots(env: SnapshotsEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT ${SELECT_COLS} FROM images_index
       WHERE org_id = ?1 AND name IS NOT NULL AND name <> ''
       ORDER BY created_at DESC LIMIT 200`,
  ).bind(caller.orgID).all<ImageRow>();
  return json((results ?? []).map(rowToJSON));
}

// GET /api/snapshots/:name
export async function getSnapshot(env: SnapshotsEnv, caller: Caller, name: string): Promise<Response> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT ${SELECT_COLS} FROM images_index WHERE org_id = ?1 AND name = ?2 LIMIT 1`,
  ).bind(caller.orgID, name).first<ImageRow>();
  if (!row) return json({ error: "snapshot not found" }, 404);
  return json(rowToJSON(row));
}

// GET /api/images — all images for the org (named + auto-cached).
export async function listImages(env: SnapshotsEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT ${SELECT_COLS} FROM images_index
       WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 200`,
  ).bind(caller.orgID).all<ImageRow>();
  return json((results ?? []).map(rowToJSON));
}

// ownerCellOfSnapshot looks up which cell owns a named snapshot so a
// delete/patch can route to the cell holding the bytes. Returns null if the
// snapshot isn't in D1 (caller gets 404 upstream).
export async function ownerCellOfSnapshot(env: SnapshotsEnv, caller: Caller, name: string): Promise<string | null> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT owner_cell_id FROM images_index WHERE org_id = ?1 AND name = ?2 LIMIT 1`,
  ).bind(caller.orgID, name).first<{ owner_cell_id: string }>();
  return row?.owner_cell_id ?? null;
}
