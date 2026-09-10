import {
  APIError,
  type CreateSessionResult,
  type MemoryBindings,
  type MemoryDocument,
  type MemoryEnvironment,
  type MemoryResource,
  type OpenComputerClient,
} from "./api.js";
import { CLIError, structuredError } from "./errors.js";

// Project memory (docs/agents/document-memory.mdx, "Owner access"): the parts
// of the `memory` command group that talk to the API and have to be right
// independently of the terminal.

/**
 * A resource of the environment as the owner sees it. `documents` is unknown
 * when the list came from deployment declarations rather than the inventory.
 */
export interface MemoryResourceSummary {
  id: string;
  provider: { kind?: string; maxBytes?: number };
  declared: boolean;
  documents?: number;
}

export interface MemoryResourceListing {
  resources: MemoryResourceSummary[];
  /** Where the list came from; declarations cannot show undeclared resources or counts. */
  source: "inventory" | "declarations";
}

/**
 * The environment's resources: the durable inventory when the backend has
 * it, otherwise the declarations of every project member's active
 * deployment there. Never one agent's declarations alone; a resource a
 * worker declares, or one no deployment declares any more, is still data.
 */
export async function memoryResources(
  client: OpenComputerClient,
  projectId: string,
  environment: MemoryEnvironment,
): Promise<MemoryResourceListing> {
  try {
    const resources = await client.memoryResources({ projectId, environment });
    return {
      resources: [...resources]
        .map((resource: MemoryResource) => ({
          id: resource.id,
          provider: resource.provider ?? {},
          declared: resource.declared,
          documents: resource.documents,
        }))
        .sort(byId),
      source: "inventory",
    };
  } catch (error) {
    // A backend without the inventory route: fall back to declarations.
    if (!(error instanceof APIError && error.status === 404)) throw error;
  }
  const project = (await client.projects()).find(
    (candidate) => candidate.id === projectId,
  );
  if (!project) throw new Error("The bound project is no longer available.");
  const deploymentIds = [
    ...new Set(
      project.environments
        .filter((candidate) => candidate.name === environment)
        .flatMap((candidate) =>
          candidate.activeDeploymentId ? [candidate.activeDeploymentId] : [],
        ),
    ),
  ];
  const byResource = new Map<string, MemoryResourceSummary>();
  for (const deploymentId of deploymentIds) {
    const deployment = await client.deployment(deploymentId);
    for (const declaration of deployment.memory ?? []) {
      if (typeof declaration.id !== "string" || byResource.has(declaration.id)) {
        continue;
      }
      byResource.set(declaration.id, {
        id: declaration.id,
        provider: {
          ...(declaration.provider?.kind ? { kind: declaration.provider.kind } : {}),
          ...(typeof declaration.provider?.maxBytes === "number"
            ? { maxBytes: declaration.provider.maxBytes }
            : {}),
        },
        declared: true,
      });
    }
  }
  return {
    resources: [...byResource.values()].sort(byId),
    source: "declarations",
  };
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export interface MemoryEditDraft {
  /** The file holding the user's edited text. */
  path: string;
  discard: () => Promise<void>;
}

/** A word as a POSIX shell reads it back unchanged. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The command that retries an edit from its kept draft: the same target
 * (project and environment included, so it never lands on the linked
 * project's Development by default), the same summary, and a path the
 * shell reads back whatever it contains.
 */
export function memoryEditResumeCommand(input: {
  projectId: string;
  resource: string;
  id: string;
  environment: MemoryEnvironment;
  summary?: string;
  draftPath: string;
}): string {
  return [
    "opencomputer memory edit",
    shellWord(input.resource),
    shellWord(input.id),
    "--project",
    shellWord(input.projectId),
    "--environment",
    input.environment,
    ...(input.summary !== undefined
      ? ["--summary", shellWord(input.summary)]
      : []),
    "--text-file",
    shellWord(input.draftPath),
  ].join(" ");
}

/**
 * Replaces a document's text at the revision that was read. On success the
 * draft file goes; on any failure it stays and the error names it, so an
 * over-limit, unreachable or failing save costs no work. An answer from the
 * API is a verdict; no answer at all (the request never arrived, or its
 * response was lost) is not, and is reported as an unconfirmed write.
 */
export async function saveMemoryEdit(
  client: OpenComputerClient,
  input: {
    projectId: string;
    resource: string;
    id: string;
    environment: MemoryEnvironment;
    etag: string;
    text: string;
    summary?: string;
    draft?: MemoryEditDraft;
  },
): Promise<MemoryDocument> {
  const { draft, ...replacement } = input;
  try {
    const { document } = await client.replaceMemoryDocument(replacement);
    await draft?.discard();
    return document;
  } catch (error) {
    const kept = draft
      ? { editedTextPath: draft.path }
      : {};
    const resume = draft
      ? ` Your edited text is kept at ${draft.path}; save it with ` +
        `\`${memoryEditResumeCommand({ ...input, draftPath: draft.path })}\`.`
      : "";
    if (!(error instanceof APIError)) {
      const failure = structuredError(error);
      throw new CLIError(
        "memory_save_unconfirmed",
        `${input.resource}/${input.id} may or may not have been saved: ${failure.message}`,
        `Run \`opencomputer memory show ${shellWord(input.resource)} ${shellWord(input.id)} --project ${shellWord(input.projectId)} --environment ${input.environment}\` to see whether the revision changed before saving again.` +
          resume,
        { ...kept, expectedRevision: input.etag },
      );
    }
    if (error.status === 412) {
      const latest = await client
        .memoryDocument(input)
        .catch(() => null);
      throw new CLIError(
        "memory_conflict",
        `${input.resource}/${input.id} changed since you opened it` +
          (latest
            ? ` (now revision ${latest.document.revision}, updated ${latest.document.updatedAt} by ${writerLabel(latest.document)})`
            : "") +
          `; your edit was not saved.`,
        "Run `opencomputer memory show` to read the current text, reconcile, and edit again." +
          resume,
        {
          status: 412,
          ...(latest ? { current: latest.document } : {}),
          ...kept,
        },
      );
    }
    const failure = structuredError(error);
    const details =
      failure.details && typeof failure.details === "object"
        ? (failure.details as Record<string, unknown>)
        : {};
    throw new CLIError(
      failure.code === "payload_too_large" ? "memory_too_large" : failure.code,
      `${input.resource}/${input.id} was not saved: ${failure.message}`,
      failure.hint + resume,
      { ...details, ...kept },
    );
  }
}

function writerLabel(document: MemoryDocument): string {
  return document.writer.kind === "agent"
    ? `agent ${document.writer.sessionId}`
    : "owner";
}

/** One bound document after `--create-document`: created now, or already there. */
export interface EnsuredMemoryDocument {
  resource: string;
  id: string;
  created: boolean;
  revision: string;
}

/**
 * Creates every document a session's bindings name that does not exist yet
 * (title = its id, empty text), and reports each with whether it was created.
 * A deleted id is reserved and a binding to it would fail admission, so it
 * fails here, before any session is created.
 */
export async function ensureMemoryDocuments(
  client: OpenComputerClient,
  input: {
    projectId: string;
    environment: MemoryEnvironment;
    bindings: MemoryBindings;
  },
): Promise<EnsuredMemoryDocument[]> {
  const ensured: EnsuredMemoryDocument[] = [];
  for (const [resource, binding] of Object.entries(input.bindings)) {
    if (binding.scope !== "document") continue;
    const target = {
      projectId: input.projectId,
      resource,
      id: binding.id,
      environment: input.environment,
    };
    try {
      const { document } = await client.createMemoryDocument({
        ...target,
        title: binding.id,
        text: "",
      });
      ensured.push({ resource, id: binding.id, created: true, revision: document.revision });
      continue;
    } catch (error) {
      if (!(error instanceof APIError && error.status === 412)) throw error;
    }
    try {
      const { document } = await client.memoryDocument(target);
      ensured.push({ resource, id: binding.id, created: false, revision: document.revision });
    } catch (error) {
      if (error instanceof APIError && error.status === 404) {
        throw new CLIError(
          "memory_document_deleted",
          `${resource}/${binding.id} was deleted and its id is reserved; a session cannot bind it.`,
          "Bind a new document id, or create one with `opencomputer memory create`.",
          { resource, id: binding.id },
        );
      }
      throw error;
    }
  }
  return ensured;
}

/**
 * Creates a session, with bindings when given. A reused `--idempotency-key`
 * whose earlier session had different inputs is a 409; name the cause.
 */
export async function createSessionWithMemory(
  client: OpenComputerClient,
  agent: string,
  memory?: MemoryBindings,
): Promise<CreateSessionResult> {
  try {
    return await client.createSession(agent, memory ? { memory } : {});
  } catch (error) {
    if (error instanceof APIError && error.status === 409) {
      throw new CLIError(
        "session_idempotency_conflict",
        "This --idempotency-key already created a session with a different agent, deployment, environment or memory bindings.",
        "Pass a new --idempotency-key to start another session, or repeat the earlier command unchanged to get the existing one.",
        { status: 409, ...(memory ? { memory } : {}) },
      );
    }
    throw error;
  }
}
