// Start a session on a memory document in one call (docs/agents/document-memory.mdx,
// "Start a session on a new document"). The management API keeps the two
// objects separate on purpose: a document is owner data with its own
// lifetime, a session binding is admission to it, and nothing creates one as
// a side effect of the other. What an application wants at the moment it
// opens a topic is still "these notes, this session", so this helper does the
// two calls in order and makes the pair converge under one key.
//
// This helper speaks to the project-scoped Serverless Agents surface
// (`/api/managed-agents/...`) with an API key, not to the Durable Agent
// Sessions client in this package. Use it from trusted server code only.

import { ConflictError, errorFromResponse, NotFoundError, OpenComputerError, type ApiErrorBody } from "./errors.js";
import type { MemoryAccess, MemoryAgentWrites, MemoryBindings, MemoryDocument, MemoryEnvironment } from "./memory.js";

const DEFAULT_MANAGED_AGENTS_URL = "https://app.opencomputer.dev";

export interface StartSessionOnDocumentParams {
  /** An OpenComputer API key with access to the project. Server-side only. */
  apiKey: string;
  /** The project whose memory holds the document. */
  projectId: string;
  /** Development and Production have separate memory; the session runs in the same environment. */
  environment: MemoryEnvironment;
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
  source?: string;
  /** The Serverless Agents API. Default `https://app.opencomputer.dev`. */
  baseUrl?: string;
  /** Override fetch (runtimes without a global, or testing). */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface StartSessionOnDocumentResult {
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

async function readBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function errorBody(body: unknown): ApiErrorBody | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return { message: error };
  if (error && typeof error === "object") return error as ApiErrorBody;
  return undefined;
}

/**
 * Creates the document if it does not exist, then creates the session bound
 * to it, and reports both ids and whether each already existed.
 *
 * - The document is created with `If-None-Match: *`; an existing document is
 *   kept as it is and reported with `created: false`. An id that was deleted
 *   is reserved and fails with a `NotFoundError`, since a binding to it would
 *   fail admission.
 * - The session is created with an `Idempotency-Key` derived from
 *   `idempotencyKey`; the same key with the same agent, deployment,
 *   environment and bindings returns the existing session with
 *   `created: false`. Anything else under the same key is a `ConflictError`.
 */
export async function startSessionOnDocument(
  params: StartSessionOnDocumentParams,
): Promise<StartSessionOnDocumentResult> {
  const doFetch = params.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (!doFetch) throw new Error("global fetch is unavailable — pass { fetch }.");
  const base = (params.baseUrl ?? DEFAULT_MANAGED_AGENTS_URL).replace(/\/+$/, "");
  const headers = { "x-api-key": params.apiKey, accept: "application/json", "content-type": "application/json" };
  const documentUrl =
    `${base}/api/managed-agents/projects/${encodeURIComponent(params.projectId)}` +
    `/memory/${encodeURIComponent(params.resource)}/documents/${encodeURIComponent(params.documentId)}` +
    `?environment=${encodeURIComponent(params.environment)}`;

  const createResponse = await doFetch(documentUrl, {
    method: "PUT",
    headers: { ...headers, "if-none-match": "*" },
    body: JSON.stringify({
      title: params.document.title,
      text: params.document.text ?? "",
      ...(params.document.summary !== undefined ? { summary: params.document.summary } : {}),
      ...(params.document.agentWrites ? { agentWrites: params.document.agentWrites } : {}),
    }),
    signal: params.signal,
  });
  let document: MemoryDocument;
  let documentCreated: boolean;
  if (createResponse.status === 201) {
    document = (await createResponse.json()) as MemoryDocument;
    documentCreated = true;
  } else if (createResponse.status === 412) {
    const readResponse = await doFetch(documentUrl, { method: "GET", headers, signal: params.signal });
    if (readResponse.status === 404) {
      throw new NotFoundError(
        404,
        {
          code: "memory_document_deleted",
          message:
            `Document ${params.resource}/${params.documentId} was deleted and its id is reserved; ` +
            "a session cannot bind it. Use a new document id.",
        },
        "document deleted",
      );
    }
    if (!readResponse.ok) throw errorFromResponse(readResponse.status, errorBody(await readBody(readResponse)));
    document = (await readResponse.json()) as MemoryDocument;
    documentCreated = false;
  } else {
    throw errorFromResponse(createResponse.status, errorBody(await readBody(createResponse)));
  }

  const sessionResponse = await doFetch(`${base}/api/managed-agents/sessions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": await sessionIdempotencyKey(params.idempotencyKey) },
    body: JSON.stringify({
      agentId: `${params.agent}@${params.environment}`,
      source: params.source ?? "api",
      memory: {
        ...params.memory,
        [params.resource]: { scope: "document", id: params.documentId, access: params.access ?? "read-write" },
      },
    }),
    signal: params.signal,
  });
  const sessionBody = await readBody(sessionResponse);
  if (sessionResponse.status === 409) {
    throw new ConflictError(
      409,
      {
        code: "idempotency_key_reused",
        message:
          `Idempotency key ${JSON.stringify(params.idempotencyKey)} already created a session with a different ` +
          "agent, deployment, environment or memory bindings. Use a new key to start another session; " +
          "the document was left as it is.",
      },
      "idempotency key reused",
    );
  }
  if (!sessionResponse.ok) throw errorFromResponse(sessionResponse.status, errorBody(sessionBody));
  const session = (sessionBody as { session?: { id?: string; status?: string; executionMode?: string } })?.session;
  if (!session?.id) throw new OpenComputerError(sessionResponse.status, undefined, "session create returned no session id");
  return {
    document: { id: document.id, created: documentCreated, revision: document.revision, title: document.title },
    session: {
      id: session.id,
      created: sessionResponse.status === 201,
      ...(session.status ? { status: session.status } : {}),
      ...(session.executionMode ? { executionMode: session.executionMode } : {}),
    },
  };
}
