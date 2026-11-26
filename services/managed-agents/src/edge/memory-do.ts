import { DurableObject } from "cloudflare:workers";

import {
  MEMORY_LIMITS,
  type AgentWrites,
  type ApplyConfigOutcome,
  type CreateDocumentInput,
  type CreateOutcome,
  type DeleteOutcome,
  type Document,
  type DocumentMeta,
  type DocumentPage,
  type IssueGrantsOutcome,
  type MemoryBinding,
  type MemoryOperations,
  type MemorySource,
  type MemoryWriter,
  type PatchDocumentInput,
  type ReadOutcome,
  type RecallOutcome,
  type RejectReason,
  type ReplaceDocumentInput,
  type ResourceConfig,
  type ResourceInventoryEntry,
  type SaveInput,
  type SaveResult,
  type WriteOutcome,
} from "./memory-contract.js";

/**
 * Project memory: one Durable Object per account, project and environment
 * (`memoryObjectName`). Owns documents with tombstones, the forward write
 * limits a promotion applies, per-session grants and the permanent
 * session-closed marker. Every outcome is a typed value from
 * `memory-contract.ts`; nothing documented throws.
 *
 * Every mutation is one SQLite transaction that checks and writes together:
 * grant, closure, write policy, expected revision and size are read in the
 * same transaction that commits the change, so no network call and no
 * Account DO read sits on the write path.
 */

interface DocumentMetaRow {
  [key: string]: SqlStorageValue;
  resource: string;
  id: string;
  title: string;
  summary: string;
  agent_writes: AgentWrites;
  revision: number;
  bytes: number;
  deleted: number;
  created_at: string;
  updated_at: string;
  writer_json: string;
}

interface DocumentRow extends DocumentMetaRow {
  text: string;
}

interface ResourceConfigRow {
  [key: string]: SqlStorageValue;
  resource: string;
  provider_kind: "document" | "http";
  max_bytes: number;
  deployment_id: string;
  activation_seq: number;
  applied_at: string;
}

interface GrantRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  resource: string;
  scope: "document" | "collection";
  document_id: string | null;
  access: "read" | "read-write";
  issued_at: string;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function now(): string {
  return new Date().toISOString();
}

function revisionString(revision: number): string {
  return String(revision);
}

function parseRevision(value: string): number | null {
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}

const META_COLUMNS =
  "resource, id, title, summary, agent_writes, revision, bytes, deleted, created_at, updated_at, writer_json";

/** Opaque list cursors: the (updated_at, id) pair of the last returned document. */
export function encodeMemoryCursor(updatedAt: string, id: string): string {
  const raw = JSON.stringify({ u: updatedAt, i: id });
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeMemoryCursor(
  cursor: string,
): { updatedAt: string; id: string } | null {
  if (typeof cursor !== "string" || !cursor || cursor.length > 512) return null;
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(
      atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { u?: unknown }).u !== "string" ||
      typeof (parsed as { i?: unknown }).i !== "string"
    ) {
      return null;
    }
    return {
      updatedAt: (parsed as { u: string }).u,
      id: (parsed as { i: string }).i,
    };
  } catch {
    return null;
  }
}

/** One overview line; newlines inside a field would break the fixed format. */
function overviewLine(row: DocumentMetaRow): string {
  const flat = (value: string) => value.replace(/\r?\n/g, " ");
  return `${row.id} | ${flat(row.title)} | ${flat(row.summary)} | ${row.updated_at.slice(0, 10)}`;
}

function normalizeBinding(binding: MemoryBinding): MemoryBinding {
  return binding.scope === "document"
    ? {
        resource: binding.resource,
        scope: "document",
        id: binding.id,
        access: binding.access,
      }
    : { resource: binding.resource, scope: "collection", access: "read" };
}

function sortBindings(bindings: MemoryBinding[]): MemoryBinding[] {
  return [...bindings]
    .map(normalizeBinding)
    .sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
}

function sameBindings(a: MemoryBinding[], b: MemoryBinding[]): boolean {
  return JSON.stringify(sortBindings(a)) === JSON.stringify(sortBindings(b));
}

/**
 * Owner operations record who wrote: the platform stamps the writer and
 * nothing user-supplied reaches this parameter (the routes reject unknown
 * body fields), so a malformed one is a programming error.
 */
function assertWriter(writer: MemoryWriter): void {
  if (
    typeof writer !== "object" ||
    writer === null ||
    (writer.kind !== "owner" &&
      (writer.kind !== "agent" || typeof writer.sessionId !== "string" || !writer.sessionId))
  ) {
    throw new Error("Memory writer must be { kind: 'owner' } or { kind: 'agent', sessionId }");
  }
}

function bindingFromGrant(row: GrantRow): MemoryBinding {
  return row.scope === "document"
    ? {
        resource: row.resource,
        scope: "document",
        id: row.document_id ?? "",
        access: row.access,
      }
    : { resource: row.resource, scope: "collection", access: "read" };
}

export class MemoryDurableObject
  extends DurableObject<Env>
  implements MemoryOperations
{
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          resource TEXT NOT NULL,
          id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL DEFAULT '',
          agent_writes TEXT NOT NULL DEFAULT 'enabled'
            CHECK (agent_writes IN ('enabled', 'disabled')),
          revision INTEGER NOT NULL DEFAULT 1,
          bytes INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          writer_json TEXT NOT NULL,
          PRIMARY KEY (resource, id)
        );
        CREATE INDEX IF NOT EXISTS documents_listing
          ON documents(resource, deleted, updated_at DESC, id);
        CREATE TABLE IF NOT EXISTS resource_config (
          resource TEXT PRIMARY KEY,
          provider_kind TEXT NOT NULL,
          max_bytes INTEGER NOT NULL,
          deployment_id TEXT NOT NULL,
          activation_seq INTEGER NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activation (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          seq INTEGER NOT NULL,
          deployment_id TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS grants (
          session_id TEXT NOT NULL,
          resource TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('document', 'collection')),
          document_id TEXT,
          access TEXT NOT NULL CHECK (access IN ('read', 'read-write')),
          issued_at TEXT NOT NULL,
          PRIMARY KEY (session_id, resource)
        );
        CREATE TABLE IF NOT EXISTS closed_sessions (
          session_id TEXT PRIMARY KEY,
          closed_at TEXT NOT NULL
        );
      `);
    });
  }

  // ── Owner and control plane ────────────────────────────────────────────

  async listDocuments(
    resource: string,
    page?: { cursor?: string; limit?: number },
  ): Promise<DocumentPage> {
    const cursor = page?.cursor ? decodeMemoryCursor(page.cursor) : null;
    if (page?.cursor && !cursor) {
      throw new Error("Invalid memory list cursor");
    }
    return this.page(resource, cursor, page?.limit);
  }

  async getDocument(resource: string, id: string): Promise<ReadOutcome> {
    const row = this.readDocumentRow(resource, id);
    if (!row) return { kind: "missing" };
    if (row.deleted) return { kind: "deleted" };
    return { kind: "document", document: this.document(row) };
  }

  async createDocument(
    resource: string,
    id: string,
    input: CreateDocumentInput,
    writer: MemoryWriter,
  ): Promise<CreateOutcome> {
    if (!MEMORY_LIMITS.documentIdPattern.test(id)) {
      throw new Error("Invalid memory document id");
    }
    assertWriter(writer);
    return this.ctx.storage.transactionSync((): CreateOutcome => {
      const existing = this.readDocumentRow(resource, id);
      if (existing) {
        return { kind: "conflict", reason: existing.deleted ? "deleted" : "exists" };
      }
      const title = input.title;
      const text = input.text ?? "";
      const summary = input.summary ?? "";
      const agentWrites = input.agentWrites ?? "enabled";
      const limit = this.checkFields({ title, text, summary }, resource);
      if (limit) return { kind: "rejected", ...limit };
      const timestamp = now();
      this.ctx.storage.sql.exec(
        `INSERT INTO documents (
           resource, id, title, summary, text, agent_writes, revision, bytes,
           deleted, created_at, updated_at, writer_json
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`,
        resource,
        id,
        title,
        summary,
        text,
        agentWrites,
        utf8Bytes(text),
        timestamp,
        timestamp,
        JSON.stringify(writer),
      );
      return { kind: "created", document: this.document(this.readDocumentRow(resource, id)!) };
    });
  }

  async replaceDocument(
    resource: string,
    id: string,
    input: ReplaceDocumentInput,
    expectedRevision: string,
    writer: MemoryWriter,
  ): Promise<WriteOutcome> {
    assertWriter(writer);
    return this.ctx.storage.transactionSync((): WriteOutcome => {
      const current = this.readDocumentRow(resource, id);
      if (!current || current.deleted) return { kind: "rejected", reason: "not_found" };
      if (parseRevision(expectedRevision) !== current.revision) {
        return { kind: "conflict", current: this.document(current) };
      }
      const summary = input.summary ?? current.summary;
      const limit = this.checkFields({ text: input.text, summary }, resource);
      if (limit) return { kind: "rejected", ...limit };
      this.writeText(current, input.text, summary, writer);
      return { kind: "written", document: this.document(this.readDocumentRow(resource, id)!) };
    });
  }

  async patchDocument(
    resource: string,
    id: string,
    input: PatchDocumentInput,
    expectedRevision: string,
    writer: MemoryWriter,
  ): Promise<WriteOutcome> {
    assertWriter(writer);
    return this.ctx.storage.transactionSync((): WriteOutcome => {
      const current = this.readDocumentRow(resource, id);
      if (!current || current.deleted) return { kind: "rejected", reason: "not_found" };
      if (parseRevision(expectedRevision) !== current.revision) {
        return { kind: "conflict", current: this.document(current) };
      }
      const title = input.title ?? current.title;
      const agentWrites = input.agentWrites ?? current.agent_writes;
      const limit = this.checkFields({ title }, resource);
      if (limit) return { kind: "rejected", ...limit };
      this.ctx.storage.sql.exec(
        `UPDATE documents
         SET title = ?, agent_writes = ?, revision = revision + 1,
             updated_at = ?, writer_json = ?
         WHERE resource = ? AND id = ?`,
        title,
        agentWrites,
        now(),
        JSON.stringify(writer),
        resource,
        id,
      );
      return { kind: "written", document: this.document(this.readDocumentRow(resource, id)!) };
    });
  }

  async deleteDocument(
    resource: string,
    id: string,
    expectedRevision: string,
    writer: MemoryWriter,
  ): Promise<DeleteOutcome> {
    assertWriter(writer);
    return this.ctx.storage.transactionSync((): DeleteOutcome => {
      const current = this.readDocumentRow(resource, id);
      if (!current || current.deleted) return { kind: "rejected", reason: "not_found" };
      if (parseRevision(expectedRevision) !== current.revision) {
        return { kind: "conflict", current: this.document(current) };
      }
      // A minimal tombstone: the id stays reserved, the content is gone.
      this.ctx.storage.sql.exec(
        `UPDATE documents
         SET deleted = 1, title = '', summary = '', text = '', bytes = 0,
             revision = revision + 1, updated_at = ?, writer_json = ?
         WHERE resource = ? AND id = ?`,
        now(),
        JSON.stringify(writer),
        resource,
        id,
      );
      return { kind: "deleted" };
    });
  }

  // ── Promotion and admission ────────────────────────────────────────────

  async applyConfig(
    seq: number,
    deploymentId: string,
    resources: ResourceConfig[],
  ): Promise<ApplyConfigOutcome> {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error("Memory activation seq must be a positive integer");
    }
    for (const resource of resources) {
      if (
        !MEMORY_LIMITS.documentIdPattern.test(resource.resource) ||
        (resource.provider !== "document" && resource.provider !== "http") ||
        !Number.isInteger(resource.maxBytes) ||
        resource.maxBytes < 1 ||
        resource.maxBytes > MEMORY_LIMITS.maxMaxBytes
      ) {
        throw new Error(`Invalid memory resource configuration for ${resource.resource}`);
      }
    }
    return this.ctx.storage.transactionSync((): ApplyConfigOutcome => {
      const current = this.activationSeq();
      if (seq <= current) {
        return { kind: "stale", seq: current, current: this.currentConfig() };
      }
      const stored = new Map(
        this.ctx.storage.sql
          .exec<ResourceConfigRow>("SELECT * FROM resource_config")
          .toArray()
          .map((row) => [row.resource, row]),
      );
      for (const resource of resources) {
        const existing = stored.get(resource.resource);
        if (existing && existing.provider_kind !== resource.provider) {
          return { kind: "rejected", reason: "provider_kind", resource: resource.resource };
        }
      }
      const timestamp = now();
      for (const resource of resources) {
        this.ctx.storage.sql.exec(
          `INSERT INTO resource_config (
             resource, provider_kind, max_bytes, deployment_id, activation_seq, applied_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(resource) DO UPDATE SET
             provider_kind = excluded.provider_kind,
             max_bytes = excluded.max_bytes,
             deployment_id = excluded.deployment_id,
             activation_seq = excluded.activation_seq,
             applied_at = excluded.applied_at`,
          resource.resource,
          resource.provider,
          resource.maxBytes,
          deploymentId,
          seq,
          timestamp,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO activation (slot, seq, deployment_id, applied_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
           seq = excluded.seq,
           deployment_id = excluded.deployment_id,
           applied_at = excluded.applied_at`,
        seq,
        deploymentId,
        timestamp,
      );
      return { kind: "applied", seq, current: this.currentConfig() };
    });
  }

  async issueGrants(
    sessionId: string,
    bindings: MemoryBinding[],
  ): Promise<IssueGrantsOutcome> {
    const requested = sortBindings(bindings);
    return this.ctx.storage.transactionSync((): IssueGrantsOutcome => {
      if (this.isClosed(sessionId)) return { kind: "closed" };
      const existing = this.grantsForSession(sessionId).map(bindingFromGrant);
      if (existing.length > 0) {
        return sameBindings(existing, requested)
          ? { kind: "issued", bindings: existing }
          : { kind: "conflict", bindings: existing };
      }
      const seen = new Set<string>();
      for (const binding of requested) {
        if (seen.has(binding.resource)) {
          // Two bindings for one resource cannot both be honoured; the
          // trusted caller normalizes by resource before calling.
          throw new Error(`Duplicate memory binding for ${binding.resource}`);
        }
        seen.add(binding.resource);
        if (!this.configFor(binding.resource)) {
          return { kind: "rejected", reason: "undeclared", resource: binding.resource };
        }
        if (binding.scope === "document") {
          const row = this.readDocumentRow(binding.resource, binding.id);
          if (!row || row.deleted) {
            return {
              kind: "rejected",
              reason: "not_found",
              resource: binding.resource,
              id: binding.id,
            };
          }
        }
      }
      const timestamp = now();
      for (const binding of requested) {
        this.ctx.storage.sql.exec(
          `INSERT INTO grants (session_id, resource, scope, document_id, access, issued_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          sessionId,
          binding.resource,
          binding.scope,
          binding.scope === "document" ? binding.id : null,
          binding.access,
          timestamp,
        );
      }
      return { kind: "issued", bindings: requested };
    });
  }

  /** The configuration in force for one resource; null until a promotion declared it. */
  async resourceConfig(resource: string): Promise<ResourceConfig | null> {
    const row = this.configFor(resource);
    return row
      ? { resource: row.resource, provider: row.provider_kind, maxBytes: row.max_bytes }
      : null;
  }

  /**
   * The durable inventory (work 026, C9): every resource a promotion ever
   * configured, with the number of live documents it holds. Documents only
   * exist under configured resources, so this is complete; it outlives the
   * declarations, which the caller overlays as `declared`.
   */
  async inventory(): Promise<ResourceInventoryEntry[]> {
    return this.ctx.storage.sql
      .exec<{ resource: string; provider_kind: "document" | "http"; max_bytes: number; documents: number }>(
        `SELECT c.resource, c.provider_kind, c.max_bytes,
                (SELECT COUNT(*) FROM documents d
                  WHERE d.resource = c.resource AND d.deleted = 0) AS documents
         FROM resource_config c
         ORDER BY c.resource`,
      )
      .toArray()
      .map((row) => ({
        id: row.resource,
        provider: { kind: row.provider_kind, maxBytes: row.max_bytes },
        documents: Number(row.documents),
      }));
  }

  /** Per-binding `writable` for session inspection: grant, policy and closure as of now. */
  async grantStates(sessionId: string): Promise<Array<{ resource: string; writable: boolean }>> {
    const closed = this.isClosed(sessionId);
    return this.grantsForSession(sessionId).map((grant) => {
      const document =
        grant.scope === "document" ? this.readDocumentRow(grant.resource, grant.document_id ?? "") : undefined;
      return {
        resource: grant.resource,
        writable:
          !closed &&
          grant.scope === "document" &&
          grant.access === "read-write" &&
          document !== undefined &&
          !document.deleted &&
          document.agent_writes === "enabled",
      };
    });
  }

  async closeSession(sessionId: string): Promise<{ closed: true }> {
    this.ctx.storage.sql.exec(
      `INSERT INTO closed_sessions (session_id, closed_at) VALUES (?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      sessionId,
      now(),
    );
    return { closed: true };
  }

  // ── Executing session ──────────────────────────────────────────────────

  async recall(sessionId: string, resource: string): Promise<RecallOutcome> {
    const access = this.sessionAccess(sessionId, resource);
    if ("rejected" in access) return { kind: "rejected", reason: access.rejected };
    const grant = access.grant;
    if (grant.scope === "document") {
      const row = this.readDocumentRow(resource, grant.document_id ?? "");
      if (!row || row.deleted) return { kind: "rejected", reason: "not_found" };
      const revision = revisionString(row.revision);
      return {
        kind: "projection",
        projection: {
          text: row.text,
          sources: [this.source(row)],
          cursor: encodeMemoryCursor(row.updated_at, row.id),
          writable: grant.access === "read-write" && row.agent_writes === "enabled",
          revision,
          documentId: row.id,
        },
      };
    }
    const rows = this.metaRows(resource, null, MEMORY_LIMITS.overviewDocuments);
    const lines: string[] = [];
    const sources: MemorySource[] = [];
    let bytes = 0;
    for (const row of rows) {
      const line = overviewLine(row);
      const lineBytes = utf8Bytes(line) + (lines.length ? 1 : 0);
      if (bytes + lineBytes > MEMORY_LIMITS.overviewBytes) break;
      bytes += lineBytes;
      lines.push(line);
      sources.push(this.source(row));
    }
    const last = rows[lines.length - 1];
    return {
      kind: "projection",
      projection: {
        text: lines.join("\n"),
        sources,
        cursor: last ? encodeMemoryCursor(last.updated_at, last.id) : "",
        writable: false,
      },
    };
  }

  async save(
    sessionId: string,
    resource: string,
    input: SaveInput,
    expectedRevision: string,
  ): Promise<SaveResult> {
    return this.ctx.storage.transactionSync((): SaveResult => {
      if (this.isClosed(sessionId)) return { status: "rejected", reason: "session_closed" };
      const writable = () =>
        this.grantsForSession(sessionId)
          .filter((grant) => grant.scope === "document" && grant.access === "read-write")
          .map((grant) => grant.resource);
      const grant = this.grantFor(sessionId, resource);
      if (!grant) return { status: "rejected", reason: "not_bound", bound: writable() };
      if (grant.scope !== "document" || grant.access !== "read-write") {
        return { status: "rejected", reason: "read_only", bound: writable() };
      }
      const current = this.readDocumentRow(resource, grant.document_id ?? "");
      if (!current || current.deleted) return { status: "rejected", reason: "not_found" };
      if (current.agent_writes !== "enabled") {
        return { status: "rejected", reason: "agent_writes_disabled" };
      }
      if (parseRevision(expectedRevision) !== current.revision) {
        return { status: "conflict", text: current.text, summary: current.summary };
      }
      const summary = input.summary ?? current.summary;
      const limit = this.checkFields({ text: input.text, summary }, resource);
      if (limit) {
        return {
          status: "rejected",
          reason: "too_large",
          field: limit.field,
          bytes: limit.bytes,
          maxBytes: limit.maxBytes,
        };
      }
      this.writeText(current, input.text, summary, { kind: "agent", sessionId });
      const written = this.readDocumentRow(resource, current.id)!;
      return {
        status: "saved",
        revision: revisionString(written.revision),
        bytes: written.bytes,
      };
    });
  }

  async readDocument(
    sessionId: string,
    resource: string,
    id: string,
  ): Promise<ReadOutcome> {
    const access = this.sessionAccess(sessionId, resource);
    if ("rejected" in access) return { kind: "rejected", reason: access.rejected };
    if (access.grant.scope === "document" && access.grant.document_id !== id) {
      return { kind: "rejected", reason: "not_bound" };
    }
    return this.getDocument(resource, id);
  }

  async listCollection(
    sessionId: string,
    resource: string,
    cursor?: string,
  ): Promise<DocumentPage | { kind: "rejected"; reason: RejectReason }> {
    const access = this.sessionAccess(sessionId, resource);
    if ("rejected" in access) return { kind: "rejected", reason: access.rejected };
    if (access.grant.scope !== "collection") return { kind: "rejected", reason: "not_bound" };
    const decoded = cursor ? decodeMemoryCursor(cursor) : null;
    if (cursor && !decoded) return { kind: "rejected", reason: "invalid_cursor" };
    return this.page(resource, decoded);
  }

  // ── Storage helpers ────────────────────────────────────────────────────

  private readDocumentRow(resource: string, id: string): DocumentRow | undefined {
    return this.ctx.storage.sql
      .exec<DocumentRow>(
        "SELECT * FROM documents WHERE resource = ? AND id = ?",
        resource,
        id,
      )
      .toArray()[0];
  }

  private metaRows(
    resource: string,
    after: { updatedAt: string; id: string } | null,
    limit: number,
  ): DocumentMetaRow[] {
    return after
      ? this.ctx.storage.sql
          .exec<DocumentMetaRow>(
            `SELECT ${META_COLUMNS} FROM documents
             WHERE resource = ? AND deleted = 0
               AND (updated_at < ? OR (updated_at = ? AND id > ?))
             ORDER BY updated_at DESC, id ASC
             LIMIT ?`,
            resource,
            after.updatedAt,
            after.updatedAt,
            after.id,
            limit,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<DocumentMetaRow>(
            `SELECT ${META_COLUMNS} FROM documents
             WHERE resource = ? AND deleted = 0
             ORDER BY updated_at DESC, id ASC
             LIMIT ?`,
            resource,
            limit,
          )
          .toArray();
  }

  private page(
    resource: string,
    after: { updatedAt: string; id: string } | null,
    limit?: number,
  ): DocumentPage {
    const size = Math.max(
      1,
      Math.min(MEMORY_LIMITS.listPageSize, Math.floor(limit ?? MEMORY_LIMITS.listPageSize)),
    );
    const rows = this.metaRows(resource, after, size + 1);
    const more = rows.length > size;
    const included = more ? rows.slice(0, size) : rows;
    const last = included[included.length - 1];
    const maxBytes = this.maxBytesFor(resource);
    return {
      documents: included.map((row) => this.meta(row, maxBytes)),
      nextCursor: more && last ? encodeMemoryCursor(last.updated_at, last.id) : null,
    };
  }

  private writeText(
    current: DocumentRow,
    text: string,
    summary: string,
    writer: MemoryWriter,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE documents
       SET text = ?, summary = ?, bytes = ?, revision = revision + 1,
           updated_at = ?, writer_json = ?
       WHERE resource = ? AND id = ?`,
      text,
      summary,
      utf8Bytes(text),
      now(),
      JSON.stringify(writer),
      current.resource,
      current.id,
    );
  }

  /** Field limits against the configuration in force right now. */
  private checkFields(
    fields: { title?: string; text?: string; summary?: string },
    resource: string,
  ):
    | { reason: "too_large"; bytes: number; maxBytes: number; field: "text" | "title" | "summary" }
    | null {
    if (fields.title !== undefined) {
      const bytes = utf8Bytes(fields.title);
      if (bytes < 1 || bytes > MEMORY_LIMITS.titleBytes) {
        return { reason: "too_large", bytes, maxBytes: MEMORY_LIMITS.titleBytes, field: "title" };
      }
    }
    if (fields.summary !== undefined) {
      const bytes = utf8Bytes(fields.summary);
      if (bytes > MEMORY_LIMITS.summaryBytes) {
        return { reason: "too_large", bytes, maxBytes: MEMORY_LIMITS.summaryBytes, field: "summary" };
      }
    }
    if (fields.text !== undefined) {
      const bytes = utf8Bytes(fields.text);
      const maxBytes = this.maxBytesFor(resource);
      if (bytes > maxBytes) return { reason: "too_large", bytes, maxBytes, field: "text" };
    }
    return null;
  }

  private configFor(resource: string): ResourceConfigRow | undefined {
    return this.ctx.storage.sql
      .exec<ResourceConfigRow>(
        "SELECT * FROM resource_config WHERE resource = ?",
        resource,
      )
      .toArray()[0];
  }

  private maxBytesFor(resource: string): number {
    return this.configFor(resource)?.max_bytes ?? MEMORY_LIMITS.defaultMaxBytes;
  }

  private activationSeq(): number {
    return (
      this.ctx.storage.sql
        .exec<{ seq: number }>("SELECT seq FROM activation WHERE slot = 1")
        .toArray()[0]?.seq ?? 0
    );
  }

  private currentConfig(): ResourceConfig[] {
    return this.ctx.storage.sql
      .exec<ResourceConfigRow>("SELECT * FROM resource_config ORDER BY resource")
      .toArray()
      .map((row) => ({
        resource: row.resource,
        provider: row.provider_kind,
        maxBytes: row.max_bytes,
      }));
  }

  private isClosed(sessionId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM closed_sessions WHERE session_id = ?", sessionId)
        .toArray().length > 0
    );
  }

  private grantsForSession(sessionId: string): GrantRow[] {
    return this.ctx.storage.sql
      .exec<GrantRow>(
        "SELECT * FROM grants WHERE session_id = ? ORDER BY resource",
        sessionId,
      )
      .toArray();
  }

  private grantFor(sessionId: string, resource: string): GrantRow | undefined {
    return this.ctx.storage.sql
      .exec<GrantRow>(
        "SELECT * FROM grants WHERE session_id = ? AND resource = ?",
        sessionId,
        resource,
      )
      .toArray()[0];
  }

  /** The grant a read-side operation runs under, or why there is none. */
  private sessionAccess(
    sessionId: string,
    resource: string,
  ): { grant: GrantRow } | { rejected: RejectReason } {
    if (this.isClosed(sessionId)) return { rejected: "session_closed" };
    const grant = this.grantFor(sessionId, resource);
    return grant ? { grant } : { rejected: "not_bound" };
  }

  private meta(row: DocumentMetaRow, maxBytes = this.maxBytesFor(row.resource)): DocumentMeta {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      agentWrites: row.agent_writes,
      revision: revisionString(row.revision),
      bytes: row.bytes,
      maxBytes,
      updatedAt: row.updated_at,
      writer: JSON.parse(row.writer_json) as MemoryWriter,
    };
  }

  private document(row: DocumentRow): Document {
    return { ...this.meta(row), text: row.text };
  }

  private source(row: DocumentMetaRow): MemorySource {
    return {
      id: row.id,
      title: row.title,
      revision: revisionString(row.revision),
      updatedAt: row.updated_at,
    };
  }
}
