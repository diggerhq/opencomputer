import { ApiError } from '@/api/client'
import type {
  ManagedMemoryDeclaration,
  ManagedMemoryDocument,
  ManagedMemoryDocumentMeta,
  ManagedMemoryEnvironment,
  ManagedMemoryResource,
} from './api'

/**
 * A resource of the environment as the owner sees it: from the durable
 * inventory when the backend has it, else from deployment declarations, in
 * which case undeclared resources and document counts are unknown.
 */
export type MemoryResourceSummary = {
  id: string
  provider: { kind: string; maxBytes?: number }
  declared: boolean
  documents?: number
}

export type MemoryResourceListing = {
  resources: MemoryResourceSummary[]
  source: 'inventory' | 'declarations'
}

function byId(left: { id: string }, right: { id: string }) {
  return left.id.localeCompare(right.id)
}

/**
 * The memory resources an environment's active deployments declare, merged by
 * id across every project member. Agents of one project share a resource by
 * id, so the first declaration seen describes it.
 */
export function memoryResourcesFromDeclarations(
  deployments: ReadonlyArray<
    { memory: ManagedMemoryDeclaration[] } | undefined
  >,
): MemoryResourceSummary[] {
  const byResource = new Map<string, MemoryResourceSummary>()
  for (const deployment of deployments) {
    for (const declaration of deployment?.memory ?? []) {
      if (byResource.has(declaration.id)) continue
      byResource.set(declaration.id, {
        id: declaration.id,
        provider: declaration.provider,
        declared: true,
      })
    }
  }
  return [...byResource.values()].sort(byId)
}

/**
 * The environment's resources: the inventory route first, since it is the
 * only complete list (a resource only a worker declares, or one nothing
 * declares any more but that still holds documents); the declarations of
 * every active project member when an older backend answers 404.
 */
export async function listMemoryResources(input: {
  inventory: () => Promise<{ resources: ManagedMemoryResource[] }>
  declarations: () => Promise<
    ReadonlyArray<{ memory: ManagedMemoryDeclaration[] } | undefined>
  >
}): Promise<MemoryResourceListing> {
  try {
    const { resources } = await input.inventory()
    return { resources: [...resources].sort(byId), source: 'inventory' }
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error
  }
  return {
    resources: memoryResourcesFromDeclarations(await input.declarations()),
    source: 'declarations',
  }
}

/** The selector's right-aligned note: limit, then whether the resource is still declared and what it holds. */
export function memoryResourceHint(resource: MemoryResourceSummary) {
  return [
    resource.declared ? undefined : 'not declared',
    resource.provider.maxBytes !== undefined
      ? formatMemoryBytes(resource.provider.maxBytes)
      : undefined,
    resource.documents !== undefined
      ? `${resource.documents} ${resource.documents === 1 ? 'document' : 'documents'}`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ')
}

/** A document larger than the resource's current limit must shrink on its next save. */
export function isOverMemoryLimit(
  document: Pick<ManagedMemoryDocumentMeta, 'bytes' | 'maxBytes'>,
) {
  return document.bytes > document.maxBytes
}

export function memoryWriterLabel(writer: ManagedMemoryDocumentMeta['writer']) {
  return writer.kind === 'agent' ? `Agent ${writer.sessionId}` : 'Owner'
}

export function formatMemoryBytes(bytes: number) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`
}

/**
 * One resource's export: the file name and body the Memory page downloads.
 * Each document carries the same fields as a document read, so the file
 * matches what `opencomputer memory export` writes per document.
 */
export function memoryExportFile(input: {
  resource: string
  environment: ManagedMemoryEnvironment
  documents: ManagedMemoryDocument[]
  exportedAt: Date
}) {
  return {
    name: `memory-${input.resource}-${input.environment}.json`,
    body: `${JSON.stringify(
      {
        resource: input.resource,
        environment: input.environment,
        exportedAt: input.exportedAt.toISOString(),
        documents: input.documents,
      },
      null,
      2,
    )}\n`,
  }
}
