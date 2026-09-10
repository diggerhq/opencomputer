import {
  APIError,
  type MemoryEnvironment,
  type MemoryResource,
  type OpenComputerClient,
} from "./api.js";

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
