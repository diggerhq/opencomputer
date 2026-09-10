import {
  APIError,
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

/**
 * Replaces a document's text at the revision that was read. On success the
 * draft file goes; on any failure it stays and the error names it, so an
 * over-limit, unreachable or failing save costs no work.
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
        `\`opencomputer memory edit ${input.resource} ${input.id} --text-file ${draft.path}\`.`
      : "";
    if (error instanceof APIError && error.status === 412) {
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
