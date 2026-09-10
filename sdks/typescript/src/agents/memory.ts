// Project memory types — the shapes of the management API documented at
// docs/agents/document-memory.mdx ("Session bindings", "Management API") and
// the `memory` field a session carries.
//
// These are types only. This client wraps the Durable Agent Sessions API
// (`/v3`); the memory management routes live on the project-scoped
// Serverless Agents surface (`/api/managed-agents/projects/<id>/memory/...`),
// which this package does not call. Use them to type the bodies you send with
// your own HTTP client, the CLI's `--json` output (`opencomputer memory ...`),
// or an export produced by `opencomputer memory export`.

export type MemoryEnvironment = "development" | "production";

export type MemoryAccess = "read" | "read-write";

/** Whether the model's `memory_save` may commit to a document. */
export type MemoryAgentWrites = "enabled" | "disabled";

/**
 * One value of the `memory` object sent when creating a session, keyed by
 * resource id: `{ requirements: { scope: "document", id: "workshop", access: "read-write" } }`.
 * `access` defaults to `read`; a collection binding is read-only.
 */
export type MemoryBinding =
  | { scope: "document"; id: string; access?: MemoryAccess }
  | { scope: "collection"; access?: "read" };

/** The `memory` field of a session create body: resource id -> binding. At most 8 entries. */
export type MemoryBindings = Record<string, MemoryBinding>;

/**
 * One entry of the `memory` array returned by session inspection. `writable`
 * is `false` once the session has ended or while the document's agent writes
 * are disabled; no credential is ever included.
 */
export type SessionMemoryBinding =
  | {
      resource: string;
      scope: "document";
      id: string;
      access: MemoryAccess;
      writable: boolean;
    }
  | { resource: string; scope: "collection"; access: "read"; writable: boolean };

/** Who last wrote a document; set by OpenComputer, never by a caller. */
export type MemoryWriter = { kind: "owner" } | { kind: "agent"; sessionId: string };

/** Document metadata as the list route returns it (no `text`). */
export interface MemoryDocumentMeta {
  id: string;
  title: string;
  summary: string;
  agentWrites: MemoryAgentWrites;
  /** Opaque. Reads and writes also return it quoted as the `ETag` header. */
  revision: string;
  /** UTF-8 size of `text`. `bytes > maxBytes` means the next save must shrink it. */
  bytes: number;
  /** The resource's current limit. */
  maxBytes: number;
  updatedAt: string;
  writer: MemoryWriter;
}

/** A full document as read, create, replace and patch return it. */
export interface MemoryDocument extends MemoryDocumentMeta {
  text: string;
}

/** A list page. Follow `nextCursor` with the `cursor` query parameter until it is `null`. */
export interface MemoryDocumentPage {
  documents: MemoryDocumentMeta[];
  nextCursor: string | null;
}

/**
 * One entry of `GET .../projects/<id>/memory?environment=`: the environment's
 * durable resource inventory. Storage outlives code, so a resource stays
 * listed while it holds documents even after every deployment stopped
 * declaring it (`declared: false`).
 */
export interface MemoryResource {
  id: string;
  provider: { kind: string; maxBytes?: number };
  /** Whether an active deployment of the environment currently declares the resource. */
  declared: boolean;
  /** Live (non-deleted) documents in the resource. */
  documents: number;
}

export interface MemoryResourceInventory {
  resources: MemoryResource[];
}

/** Body of `PUT .../documents/<id>` with `If-None-Match: *`. */
export interface CreateMemoryDocumentBody {
  title: string;
  text: string;
  /** Default `""`. */
  summary?: string;
  /** Default `"enabled"`. */
  agentWrites?: MemoryAgentWrites;
}

/** Body of `PUT .../documents/<id>` with `If-Match: "<revision>"`. An omitted summary is preserved. */
export interface ReplaceMemoryDocumentBody {
  text: string;
  summary?: string;
}

/** Body of `PATCH .../documents/<id>` with `If-Match: "<revision>"`. Omitted fields stay unchanged. */
export interface PatchMemoryDocumentBody {
  title?: string;
  agentWrites?: MemoryAgentWrites;
}

/** The `memory.saved` session event's data: a save the session observed succeeding. */
export interface MemorySavedEvent {
  resource: string;
  documentId: string;
  revision: string;
  bytes: number;
}

/** Error codes the memory management routes return in `{ error: { code, message } }`. */
export type MemoryErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "precondition_failed"
  | "memory_limit_exceeded"
  | "precondition_required";
