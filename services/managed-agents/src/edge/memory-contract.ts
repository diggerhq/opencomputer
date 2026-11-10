/**
 * Project memory: the contract between the Memory Durable Object and its
 * callers (edge owner routes, Account DO admission and promotion, Session DO
 * closure, the Workerd host at render and tool time).
 *
 * This file is the seam the memory streams build against in parallel. The
 * public behaviour it encodes is documented in the opencomputer repository
 * (docs/agents/document-memory.mdx, docs/agents/memory-providers.mdx); the
 * state machines behind it are in the serverless-agents workspace
 * (product/openmuse/working-thesis.md, "How the three protocols work").
 *
 * Every operation returns a typed outcome. Nothing here throws for an
 * outcome the documentation lists; throwing is reserved for programming
 * errors and storage failures.
 */

import type { ProjectEnvironmentName } from "../protocol.js";
import { isProjectEnvironmentName } from "./project-scope.js";

export type MemoryEnvironment = ProjectEnvironmentName;

export type MemoryAccess = "read" | "read-write";

/** Which document, or the whole collection, a session may reach through one resource. */
export type MemoryBinding =
  | { resource: string; scope: "document"; id: string; access: MemoryAccess }
  | { resource: string; scope: "collection"; access: "read" };

/** Who performed a mutation; stamped by the platform, never supplied by a caller. */
export type MemoryWriter =
  | { kind: "owner" }
  | { kind: "agent"; sessionId: string };

export type AgentWrites = "enabled" | "disabled";

export interface DocumentMeta {
  id: string;
  title: string;
  summary: string;
  agentWrites: AgentWrites;
  revision: string;
  bytes: number;
  maxBytes: number;
  updatedAt: string;
  writer: MemoryWriter;
}

export interface Document extends DocumentMeta {
  text: string;
}

export interface DocumentPage {
  documents: DocumentMeta[];
  nextCursor: string | null;
}

export interface CreateDocumentInput {
  title: string;
  text?: string;
  summary?: string;
  agentWrites?: AgentWrites;
}

export interface ReplaceDocumentInput {
  text: string;
  /** Omitted preserves the current summary; empty string clears it. */
  summary?: string;
}

export interface PatchDocumentInput {
  title?: string;
  agentWrites?: AgentWrites;
}

/** Why a write could not be applied. Mirrors the documented tool results and HTTP codes. */
export type RejectReason =
  | "not_bound"
  | "not_found"
  | "agent_writes_disabled"
  | "too_large"
  | "session_closed"
  | "read_only"
  | "invalid_cursor";

/** Which field broke its byte limit; `text` is bounded by the resource's `maxBytes`. */
export type LimitedField = "text" | "title" | "summary";

export type CreateOutcome =
  | { kind: "created"; document: Document }
  | { kind: "conflict"; reason: "exists" | "deleted" }
  | { kind: "rejected"; reason: RejectReason; bytes?: number; maxBytes?: number; field?: LimitedField };

export type WriteOutcome =
  | { kind: "written"; document: Document }
  | { kind: "conflict"; current: Document }
  | { kind: "rejected"; reason: RejectReason; bytes?: number; maxBytes?: number; field?: LimitedField };

export type DeleteOutcome =
  | { kind: "deleted" }
  | { kind: "conflict"; current: Document }
  | { kind: "rejected"; reason: RejectReason };

export type ReadOutcome =
  | { kind: "document"; document: Document }
  | { kind: "deleted" }
  | { kind: "missing" }
  | { kind: "rejected"; reason: RejectReason };

/** A tool an HTTP memory provider declares in the deployment (memory-providers.mdx). */
export interface HttpToolDeclaration {
  name: string;
  description: string;
  access: "read" | "write";
  idempotent?: boolean;
  input: Record<string, unknown>;
}

/** What a compiled artifact declares and `registerDeployment` carries (work 026, C3). */
export type MemoryDeclaration =
  | { id: string; description: string; provider: { kind: "document"; maxBytes: number } }
  | {
      id: string;
      description: string;
      provider: {
        kind: "http";
        connection: string;
        path: string;
        maxBytes: number;
        tools: HttpToolDeclaration[];
      };
    };

/** Per-resource configuration a promotion applies before it selects code. */
export type ResourceConfig =
  | { resource: string; provider: "document"; maxBytes: number }
  | { resource: string; provider: "http"; maxBytes: number };

export type ApplyConfigOutcome =
  | { kind: "applied"; seq: number; current: ResourceConfig[] }
  | { kind: "stale"; seq: number; current: ResourceConfig[] }
  | { kind: "rejected"; reason: "provider_kind"; resource: string };

/** One row of the durable resource inventory (work 026, C9): configuration plus live document count. */
export interface ResourceInventoryEntry {
  id: string;
  provider: { kind: "document" | "http"; maxBytes: number };
  documents: number;
}

export type IssueGrantsOutcome =
  | { kind: "issued"; bindings: MemoryBinding[] }
  | { kind: "conflict"; bindings: MemoryBinding[] }
  | { kind: "closed" }
  | { kind: "rejected"; reason: "not_found" | "undeclared"; resource: string; id?: string };

/** What a render receives for one bound resource. */
export interface MemorySource {
  id: string;
  title: string;
  revision: string;
  updatedAt: string;
}

export interface MemoryProjection {
  text: string;
  sources: MemorySource[];
  /** Opaque; the host keeps it with the request snapshot. */
  cursor: string;
  writable: boolean;
  /** Present for a document binding: the revision a later save is checked against. */
  revision?: string;
  documentId?: string;
}

export type RecallOutcome =
  | { kind: "projection"; projection: MemoryProjection }
  | { kind: "rejected"; reason: RejectReason };

/**
 * The model-facing result of memory_save; the tool returns exactly this
 * JSON. `not_bound` is a resource this session holds no grant for and
 * `read_only` one it may only read; both list what it can write.
 * `session_closed` is a session whose grants were revoked by end.
 * `stale` is a call from an assistant message that was already in the
 * transcript when a later request was rendered (an interrupted turn's
 * delayed tool call, for example): the host never applies it to the
 * latest snapshot; the model saves again from its current step if it
 * still wants to.
 */
export type SaveResult =
  | { status: "saved"; revision: string; bytes: number }
  | { status: "conflict"; text: string; summary: string }
  | { status: "rejected"; reason: "agent_writes_disabled" }
  | { status: "rejected"; reason: "too_large"; field: LimitedField; bytes: number; maxBytes: number }
  | { status: "rejected"; reason: "not_found" }
  | { status: "rejected"; reason: "not_bound"; bound: string[] }
  | { status: "rejected"; reason: "read_only"; bound: string[] }
  | { status: "rejected"; reason: "session_closed" }
  | { status: "rejected"; reason: "stale" };

export interface SaveInput {
  text: string;
  summary?: string;
}

/**
 * The Memory Durable Object. One instance per account, project and
 * environment; its name is `${accountId}:${projectId}:${environment}`.
 */
export interface MemoryOperations {
  // Owner and control plane. `writer` is stamped by the trusted caller.
  listDocuments(resource: string, page?: { cursor?: string; limit?: number }): Promise<DocumentPage>;
  getDocument(resource: string, id: string): Promise<ReadOutcome>;
  createDocument(resource: string, id: string, input: CreateDocumentInput, writer: MemoryWriter): Promise<CreateOutcome>;
  replaceDocument(resource: string, id: string, input: ReplaceDocumentInput, expectedRevision: string, writer: MemoryWriter): Promise<WriteOutcome>;
  patchDocument(resource: string, id: string, input: PatchDocumentInput, expectedRevision: string, writer: MemoryWriter): Promise<WriteOutcome>;
  deleteDocument(resource: string, id: string, expectedRevision: string, writer: MemoryWriter): Promise<DeleteOutcome>;

  /** The configuration in force for one resource; null until a promotion declared it. */
  resourceConfig(resource: string): Promise<ResourceConfig | null>;
  /** Every configured resource with its live document count; the durable inventory, independent of current code. */
  inventory(): Promise<ResourceInventoryEntry[]>;

  // Promotion and admission.
  applyConfig(seq: number, deploymentId: string, resources: ResourceConfig[]): Promise<ApplyConfigOutcome>;
  issueGrants(sessionId: string, bindings: MemoryBinding[]): Promise<IssueGrantsOutcome>;
  /** Per-binding `writable` for session inspection: grant, policy and closure as of now. */
  grantStates(sessionId: string): Promise<Array<{ resource: string; writable: boolean }>>;
  closeSession(sessionId: string): Promise<{ closed: true }>;

  // Executing session. `sessionId` is the managed session id presented by the trusted host.
  recall(sessionId: string, resource: string): Promise<RecallOutcome>;
  save(sessionId: string, resource: string, input: SaveInput, expectedRevision: string): Promise<SaveResult>;
  readDocument(sessionId: string, resource: string, id: string): Promise<ReadOutcome>;
  listCollection(sessionId: string, resource: string, cursor?: string): Promise<DocumentPage | { kind: "rejected"; reason: RejectReason }>;
}

/**
 * How edge consumers hold the Memory DO: as its contract, never its class.
 * The class implements `MemoryOperations`; a stub typed this way exposes
 * exactly the documented operations.
 */
export type MemoryStub = DurableObjectStub<MemoryOperations & Rpc.DurableObjectBranded>;
export type MemoryNamespace = DurableObjectNamespace<MemoryOperations & Rpc.DurableObjectBranded>;

export const MEMORY_LIMITS = {
  defaultMaxBytes: 8_192,
  maxMaxBytes: 16_384,
  titleBytes: 240,
  summaryBytes: 240,
  documentIdPattern: /^[A-Za-z0-9_-]{1,128}$/,
  bindingsPerSession: 8,
  overviewDocuments: 50,
  overviewBytes: 16_384,
  listPageSize: 50,
} as const;

/**
 * The Memory DO name for one project environment. A project id is the
 * account's project record, never the `project:<agentId>` placeholder the
 * edge uses for agents outside any project: memory needs a real project.
 */
export function memoryObjectName(accountId: string, projectId: string, environment: MemoryEnvironment): string {
  if (!accountId || accountId.includes(":")) {
    throw new Error("Memory needs an account id without ':'");
  }
  if (!projectId || projectId.startsWith("project:") || projectId.includes(":")) {
    throw new Error("Memory needs a project; an agent outside a project has no memory scope");
  }
  if (!isProjectEnvironmentName(environment)) {
    throw new Error("Memory needs a canonical project environment");
  }
  return `${accountId}:${projectId}:${environment}`;
}
