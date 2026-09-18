// Start a session on a memory document in one call (docs/agents/document-memory.mdx,
// "Start a session on a new document"). The management API keeps the two
// objects separate on purpose: a document is owner data with its own
// lifetime, a session binding is admission to it, and nothing creates one as
// a side effect of the other. What an application wants at the moment it
// opens a topic is still "these notes, this session", so this helper does the
// two calls in order and makes the pair converge under one key.

import { OpenComputerError } from "./errors.js";
import { type Answer, type Http, segment } from "./http.js";
import * as shapes from "./shapes.js";
import type { MemoryAccess, MemoryAgentWrites, MemoryBindings, MemoryDocument } from "./memory.js";
import type { Environment, SessionCreated, SessionSource } from "./types.js";

export interface StartOnDocumentParams {
  /** The project whose memory holds the document. */
  projectId: string;
  /** Development and Production have separate memory; the session runs in the same environment. */
  environment: Environment;
  /** The deployed agent's id (not `agent@alias`; the environment above supplies the alias). */
  agent: string;
  /** The declared memory resource and the document id to bind. */
  resource: string;
  documentId: string;
  /** What to create when the document does not exist yet. Ignored when it does. */
  document: {
    title: string;
    /** Default `""`. */
    text?: string;
    /** Default `""`. */
    summary?: string;
    /** Default `"enabled"`. */
    agentWrites?: MemoryAgentWrites;
  };
  /** The binding's access. Default `read-write`. */
  access?: MemoryAccess;
  /** Further bindings for the session, keyed by resource id. */
  memory?: MemoryBindings;
  /**
   * One key for the whole operation. A retry with the same key returns the
   * same session; the document converges on its id regardless.
   */
  idempotencyKey: string;
  /** The session's `source`. Default `api`. */
  source?: SessionSource;
  signal?: AbortSignal;
}

export interface StartOnDocumentResult {
  document: {
    id: string;
    /** False when the document already existed; its content was left as it was. */
    created: boolean;
    /** The current revision, for a later conditional owner write. */
    revision: string;
    title: string;
  };
  session: {
    id: string;
    /** False when the key had already created this session. */
    created: boolean;
    status?: string;
    executionMode?: string;
  };
}

/**
 * The session-create `Idempotency-Key` derived from the caller's key: stable
 * for a retry, distinct from any other use of the same caller key.
 */
export async function sessionIdempotencyKey(idempotencyKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(`opencomputer.memory.session\0${idempotencyKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Creates the document if it does not exist, then creates the session bound
 * to it, and reports both ids and whether each already existed.
 *
 * - The document is created with `If-None-Match: *`; an existing document is
 *   kept as it is and reported with `created: false`. An id that was deleted
 *   is reserved and fails with code `memory_document_deleted`, since a
 *   binding to it would fail admission.
 * - The session is created with an `Idempotency-Key` derived from
 *   `idempotencyKey`; the same key with the same agent, environment and
 *   bindings returns the existing session with `created: false`, after a
 *   redeploy too, since the platform records the deployment the session
 *   started on. Anything else under the same key fails with code
 *   `idempotency_key_reused`.
 */
export async function startOnDocument(http: Http, params: StartOnDocumentParams): Promise<StartOnDocumentResult> {
  const documentPath =
    `/projects/${segment(params.projectId)}/memory/${segment(params.resource)}/documents/${segment(params.documentId)}`;
  const query = { environment: params.environment };

  let document: MemoryDocument;
  let documentCreated: boolean;
  try {
    const created = await http.send("PUT", documentPath, shapes.memoryDocument, {
      query,
      headers: { "if-none-match": "*" },
      body: {
        title: params.document.title,
        text: params.document.text ?? "",
        ...(params.document.summary !== undefined ? { summary: params.document.summary } : {}),
        ...(params.document.agentWrites ? { agentWrites: params.document.agentWrites } : {}),
      },
      signal: params.signal,
    });
    document = created.body;
    documentCreated = true;
  } catch (cause) {
    if (!(cause instanceof OpenComputerError) || cause.status !== 412) throw cause;
    try {
      document = await http.request("GET", documentPath, shapes.memoryDocument, { query, signal: params.signal });
    } catch (readCause) {
      if (readCause instanceof OpenComputerError && readCause.status === 404) {
        throw new OpenComputerError(
          404,
          "memory_document_deleted",
          `Document ${params.resource}/${params.documentId} was deleted and its id is reserved; ` +
            "a session cannot bind it. Use a new document id.",
        );
      }
      throw readCause;
    }
    documentCreated = false;
  }

  let created: Answer<Omit<SessionCreated, "created">>;
  try {
    created = await http.send("POST", "/sessions", shapes.sessionCreated, {
      headers: { "idempotency-key": await sessionIdempotencyKey(params.idempotencyKey) },
      body: {
        agentId: `${params.agent}@${params.environment}`,
        source: params.source ?? "api",
        memory: {
          ...params.memory,
          [params.resource]: { scope: "document", id: params.documentId, access: params.access ?? "read-write" },
        },
      },
      signal: params.signal,
    });
  } catch (cause) {
    if (cause instanceof OpenComputerError && cause.status === 409) {
      throw new OpenComputerError(
        409,
        "idempotency_key_reused",
        `Idempotency key ${JSON.stringify(params.idempotencyKey)} already created a session with a different ` +
          "agent, environment or memory bindings. Use a new key to start another session; " +
          "the document was left as it is.",
      );
    }
    throw cause;
  }
  const { session } = created.body;
  return {
    document: { id: document.id, created: documentCreated, revision: document.revision, title: document.title },
    session: {
      id: session.id,
      created: created.status === 201,
      ...(session.status ? { status: session.status } : {}),
      ...(session.executionMode ? { executionMode: session.executionMode } : {}),
    },
  };
}
