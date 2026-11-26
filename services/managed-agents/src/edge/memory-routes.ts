import type { AccountDurableObject } from "./account-do.js";
import type { RequestIdentity } from "./auth.js";
import { json, problem, readBoundedJson } from "./http.js";
import {
  MEMORY_LIMITS,
  memoryObjectName,
  type AgentWrites,
  type CreateOutcome,
  type DeleteOutcome,
  type Document,
  type MemoryEnvironment,
  type MemoryNamespace,
  type MemoryOperations,
  type WriteOutcome,
} from "./memory-contract.js";
import { decodeMemoryCursor } from "./memory-do.js";
import type { Project } from "../protocol.js";
import { resolveProjectScope } from "./project-scope.js";

/**
 * Owner routes for document memory, mirroring the public management API at
 * `/v1/projects/:projectId/memory/:resource/documents[/:id]?environment=`.
 * The public edge passes `ETag`, `If-Match` and `If-None-Match` through
 * untouched, so the conditional protocol lives here: create needs
 * `If-None-Match: *`, every other mutation needs `If-Match`, and a document
 * response carries its quoted revision as `ETag`.
 */

export interface MemoryRouteEnv {
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
  /** The Memory DO namespace; the routes use only the `MemoryOperations` contract of its stubs. */
  MEMORY?: MemoryNamespace;
}

export interface MemoryRoutePath {
  projectId: string;
  resource: string;
  documentId?: string;
}

const OWNER = { kind: "owner" } as const;
const BODY_LIMIT = 64 * 1024;

export const MEMORY_ROUTE_PATTERN =
  /^\/v1\/projects\/([^/]+)\/memory\/([^/]+)\/documents(?:\/([^/]+))?$/;

export const MEMORY_INVENTORY_PATTERN = /^\/v1\/projects\/([^/]+)\/memory$/;

function documentResponse(document: Document, status: number): Response {
  return json(document, { status, headers: { etag: `"${document.revision}"` } });
}

/** `If-Match: "12"`, `If-Match: 12` and a weak validator all name revision 12. */
function revisionFromHeader(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim().replace(/^W\//i, "");
  const unquoted = /^"(.*)"$/.exec(trimmed)?.[1] ?? trimmed;
  return unquoted;
}

function stringField(
  body: Record<string, unknown>,
  name: string,
): { value?: string } | { invalid: string } {
  if (!(name in body)) return {};
  const value = body[name];
  return typeof value === "string" ? { value } : { invalid: `${name} must be a string` };
}

function agentWritesField(
  body: Record<string, unknown>,
): { value?: AgentWrites } | { invalid: string } {
  if (!("agentWrites" in body)) return {};
  const value = body.agentWrites;
  return value === "enabled" || value === "disabled"
    ? { value }
    : { invalid: 'agentWrites must be "enabled" or "disabled"' };
}

function unknownFields(body: Record<string, unknown>, allowed: string[]): string | null {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  return unexpected.length ? `Unknown field ${unexpected[0]!}` : null;
}

function rejection(
  outcome: Extract<CreateOutcome | WriteOutcome | DeleteOutcome, { kind: "rejected" }>,
): Response {
  switch (outcome.reason) {
    case "too_large": {
      const field = "field" in outcome && outcome.field ? outcome.field : "text";
      return problem(
        413,
        "memory_limit_exceeded",
        `${field} is ${String("bytes" in outcome ? outcome.bytes : "?")} bytes; the limit is ${String("maxBytes" in outcome ? outcome.maxBytes : "?")} bytes`,
      );
    }
    case "not_found":
      return problem(404, "not_found", "Document not found");
    default:
      return problem(400, "invalid_request", `Memory write rejected: ${outcome.reason}`);
  }
}

/**
 * The project, the environment and the Memory DO a memory route addresses,
 * or the response that refuses it.
 */
async function memoryScope(
  request: Request,
  env: MemoryRouteEnv,
  identity: RequestIdentity,
  projectId: string,
): Promise<
  | { project: Project; environment: MemoryEnvironment; memory: MemoryOperations; account: DurableObjectStub<AccountDurableObject> }
  | Response
> {
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const project = await account.getProject(projectId);
  if (!project || (identity.projectId && identity.projectId !== project.id)) {
    return problem(404, "project_not_found", "Project not found");
  }
  if (!env.MEMORY) {
    return problem(503, "memory_unavailable", "Project memory is not configured");
  }
  const requested = new URL(request.url).searchParams.get("environment");
  const scoped = resolveProjectScope(project, requested, { legacyDefault: "required" });
  if (!scoped.ok) {
    return problem(
      scoped.error.status,
      scoped.error.code === "invalid_environment" ? "invalid_request" : scoped.error.code,
      scoped.error.message,
      { projectId: project.id },
    );
  }
  const environment: MemoryEnvironment = scoped.scope.environment;
  return {
    project,
    environment,
    account,
    memory: env.MEMORY.getByName(memoryObjectName(identity.accountId, project.id, environment)),
  };
}

/**
 * `GET /v1/projects/:projectId/memory?environment=` (work 026, C9): the
 * Memory DO's durable inventory, each resource marked `declared` when any
 * active deployment of the environment currently declares it. Owner
 * discovery and export enumerate from here, never from one agent's code.
 */
export async function routeProjectMemoryInventory(
  request: Request,
  env: MemoryRouteEnv,
  identity: RequestIdentity,
  projectId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return problem(405, "method_not_allowed", "Only GET lists memory resources");
  }
  const scope = await memoryScope(request, env, identity, projectId);
  if (scope instanceof Response) return scope;
  const declared = await declaredResources(scope.account, scope.project, scope.environment);
  const resources = (await scope.memory.inventory()).map((entry) => ({
    id: entry.id,
    provider: entry.provider,
    declared: declared.has(entry.id),
    documents: entry.documents,
  }));
  return json({ resources });
}

/** The one Account DO read the inventory needs; typed narrowly so the stub's full RPC surface is not instantiated here. */
interface ActivationReader {
  activeMemoryResources(projectId: string, environment: MemoryEnvironment): Promise<string[]>;
}

/** Resource ids the environment's selected activation declares: the aggregate over every active member, not one agent's code. */
async function declaredResources(
  account: DurableObjectStub<AccountDurableObject>,
  project: Project,
  environment: MemoryEnvironment,
): Promise<Set<string>> {
  const reader = account as unknown as ActivationReader;
  return new Set(await reader.activeMemoryResources(project.id, environment));
}

export async function routeProjectMemory(
  request: Request,
  env: MemoryRouteEnv,
  identity: RequestIdentity,
  path: MemoryRoutePath,
): Promise<Response> {
  const scope = await memoryScope(request, env, identity, path.projectId);
  if (scope instanceof Response) return scope;
  const { environment, memory } = scope;
  const url = new URL(request.url);
  if (!MEMORY_LIMITS.documentIdPattern.test(path.resource)) {
    return problem(400, "invalid_request", "Invalid memory resource id");
  }
  if (path.documentId !== undefined && !MEMORY_LIMITS.documentIdPattern.test(path.documentId)) {
    return problem(400, "invalid_request", "Document ids are 1-128 characters: letters, digits, - and _");
  }
  if (!(await memory.resourceConfig(path.resource))) {
    return problem(
      404,
      "not_found",
      `Memory resource ${path.resource} is not declared for the ${environment} environment`,
    );
  }

  if (path.documentId === undefined) {
    if (request.method !== "GET") {
      return problem(405, "method_not_allowed", "Only GET lists documents");
    }
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor !== undefined && !decodeMemoryCursor(cursor)) {
      return problem(400, "invalid_request", "Invalid cursor");
    }
    return json(await memory.listDocuments(path.resource, cursor ? { cursor } : {}));
  }

  const id = path.documentId;
  const ifMatch = revisionFromHeader(request.headers.get("if-match"));
  const ifNoneMatch = request.headers.get("if-none-match")?.trim();

  if (request.method === "GET") {
    const outcome = await memory.getDocument(path.resource, id);
    if (outcome.kind !== "document") {
      return problem(404, "not_found", "Document not found");
    }
    return documentResponse(outcome.document, 200);
  }

  if (request.method === "PUT") {
    if (ifNoneMatch !== undefined && ifMatch !== undefined) {
      return problem(400, "invalid_request", "Send If-None-Match: * to create or If-Match to replace, not both");
    }
    if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
      return problem(400, "invalid_request", "If-None-Match must be * for a create");
    }
    if (ifNoneMatch === undefined && ifMatch === undefined) {
      return problem(428, "precondition_required", "Send If-None-Match: * to create or If-Match: \"<revision>\" to replace");
    }
    const body = await readBoundedJson(request, BODY_LIMIT);
    if (!body) return problem(400, "invalid_request", "Expected a JSON object body");
    if (ifNoneMatch === "*") {
      const unknown = unknownFields(body, ["title", "text", "summary", "agentWrites"]);
      if (unknown) return problem(400, "invalid_request", unknown);
      const title = stringField(body, "title");
      const text = stringField(body, "text");
      const summary = stringField(body, "summary");
      const agentWrites = agentWritesField(body);
      for (const field of [title, text, summary, agentWrites]) {
        if ("invalid" in field) return problem(400, "invalid_request", field.invalid);
      }
      if (!("value" in title) || title.value === undefined) {
        return problem(400, "invalid_request", "title is required");
      }
      const outcome = await memory.createDocument(
        path.resource,
        id,
        {
          title: title.value,
          ...("value" in text && text.value !== undefined ? { text: text.value } : {}),
          ...("value" in summary && summary.value !== undefined ? { summary: summary.value } : {}),
          ...("value" in agentWrites && agentWrites.value ? { agentWrites: agentWrites.value } : {}),
        },
        OWNER,
      );
      if (outcome.kind === "created") return documentResponse(outcome.document, 201);
      if (outcome.kind === "conflict") {
        return problem(
          412,
          "precondition_failed",
          outcome.reason === "deleted"
            ? "Document id was deleted and stays reserved; use a new id"
            : "Document already exists",
        );
      }
      return rejection(outcome);
    }
    const unknown = unknownFields(body, ["text", "summary"]);
    if (unknown) return problem(400, "invalid_request", unknown);
    const text = stringField(body, "text");
    const summary = stringField(body, "summary");
    for (const field of [text, summary]) {
      if ("invalid" in field) return problem(400, "invalid_request", field.invalid);
    }
    if (!("value" in text) || text.value === undefined) {
      return problem(400, "invalid_request", "text is required");
    }
    const outcome = await memory.replaceDocument(
      path.resource,
      id,
      {
        text: text.value,
        ...("value" in summary && summary.value !== undefined ? { summary: summary.value } : {}),
      },
      ifMatch!,
      OWNER,
    );
    if (outcome.kind === "written") return documentResponse(outcome.document, 200);
    if (outcome.kind === "conflict") return staleRevision(outcome.current);
    return rejection(outcome);
  }

  if (request.method === "PATCH") {
    if (ifMatch === undefined) {
      return problem(428, "precondition_required", 'Send If-Match: "<revision>"');
    }
    const body = await readBoundedJson(request, BODY_LIMIT);
    if (!body) return problem(400, "invalid_request", "Expected a JSON object body");
    const unknown = unknownFields(body, ["title", "agentWrites"]);
    if (unknown) return problem(400, "invalid_request", unknown);
    const title = stringField(body, "title");
    const agentWrites = agentWritesField(body);
    for (const field of [title, agentWrites]) {
      if ("invalid" in field) return problem(400, "invalid_request", field.invalid);
    }
    const patch = {
      ...("value" in title && title.value !== undefined ? { title: title.value } : {}),
      ...("value" in agentWrites && agentWrites.value ? { agentWrites: agentWrites.value } : {}),
    };
    if (!Object.keys(patch).length) {
      return problem(400, "invalid_request", "Expected title, agentWrites, or both");
    }
    const outcome = await memory.patchDocument(path.resource, id, patch, ifMatch, OWNER);
    if (outcome.kind === "written") return documentResponse(outcome.document, 200);
    if (outcome.kind === "conflict") return staleRevision(outcome.current);
    return rejection(outcome);
  }

  if (request.method === "DELETE") {
    if (ifMatch === undefined) {
      return problem(428, "precondition_required", 'Send If-Match: "<revision>"');
    }
    const outcome = await memory.deleteDocument(path.resource, id, ifMatch, OWNER);
    if (outcome.kind === "deleted") return new Response(null, { status: 204 });
    if (outcome.kind === "conflict") return staleRevision(outcome.current);
    return rejection(outcome);
  }

  return problem(405, "method_not_allowed", "Expected GET, PUT, PATCH or DELETE");
}

function staleRevision(current: Document): Response {
  return json(
    {
      error: {
        code: "precondition_failed",
        message: `Document is at revision ${current.revision}; fetch it and reconcile before retrying`,
      },
    },
    { status: 412, headers: { etag: `"${current.revision}"` } },
  );
}
