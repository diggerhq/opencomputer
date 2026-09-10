import type {
  ManagedMemoryDeclaration,
  ManagedMemoryDocument,
  ManagedMemoryDocumentMeta,
  ManagedMemoryEnvironment,
} from './api'

/**
 * The memory resources an environment's active deployments declare, merged by
 * id. Agents of one project share a resource by id, so the first declaration
 * seen describes it; a resource the documents list knows but no deployment
 * declares is still reachable by typing its id.
 */
export function declaredMemoryResources(
  deployments: ReadonlyArray<
    { memory: ManagedMemoryDeclaration[] } | undefined
  >,
): ManagedMemoryDeclaration[] {
  const byId = new Map<string, ManagedMemoryDeclaration>()
  for (const deployment of deployments) {
    for (const declaration of deployment?.memory ?? []) {
      if (!byId.has(declaration.id)) byId.set(declaration.id, declaration)
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
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
