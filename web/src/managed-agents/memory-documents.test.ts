import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import {
  formatMemoryBytes,
  isOverMemoryLimit,
  listMemoryResources,
  memoryExportFile,
  memoryResourceHint,
  memoryResourcesFromDeclarations,
  memoryWriterLabel,
} from './memory-documents'

const requirements = {
  id: 'requirements',
  description: 'Verified requirements.',
  provider: { kind: 'document', maxBytes: 8192 },
}

describe('memoryResourcesFromDeclarations', () => {
  it('merges declarations across every member deployment by id, first wins, sorted', () => {
    expect(
      memoryResourcesFromDeclarations([
        { memory: [{ ...requirements, id: 'notes' }, requirements] },
        undefined,
        {
          memory: [
            { ...requirements, provider: { kind: 'document', maxBytes: 16 } },
            { ...requirements, id: 'budget' },
          ],
        },
      ]),
    ).toEqual([
      {
        id: 'budget',
        provider: { kind: 'document', maxBytes: 8192 },
        declared: true,
      },
      {
        id: 'notes',
        provider: { kind: 'document', maxBytes: 8192 },
        declared: true,
      },
      {
        id: 'requirements',
        provider: { kind: 'document', maxBytes: 8192 },
        declared: true,
      },
    ])
  })
})

describe('listMemoryResources', () => {
  const inventory = [
    {
      id: 'scratch',
      provider: { kind: 'document', maxBytes: 4096 },
      declared: false,
      documents: 2,
    },
    {
      id: 'requirements',
      provider: { kind: 'document', maxBytes: 8192 },
      declared: true,
      documents: 3,
    },
  ]

  it('prefers the durable inventory, undeclared resources included', async () => {
    let declarationsAsked = false
    const listing = await listMemoryResources({
      inventory: () => Promise.resolve({ resources: inventory }),
      declarations: () => {
        declarationsAsked = true
        return Promise.resolve([])
      },
    })
    expect(listing.source).toBe('inventory')
    expect(listing.resources.map((resource) => resource.id)).toEqual([
      'requirements',
      'scratch',
    ])
    expect(declarationsAsked).toBe(false)
  })

  it('falls back to every active deployment declaration when the route is missing', async () => {
    const listing = await listMemoryResources({
      inventory: () => Promise.reject(new ApiError('Not found', 404)),
      declarations: () =>
        Promise.resolve([
          { memory: [requirements] },
          { memory: [{ ...requirements, id: 'worker-notes' }] },
        ]),
    })
    expect(listing).toEqual({
      source: 'declarations',
      resources: [
        {
          id: 'requirements',
          provider: { kind: 'document', maxBytes: 8192 },
          declared: true,
        },
        {
          id: 'worker-notes',
          provider: { kind: 'document', maxBytes: 8192 },
          declared: true,
        },
      ],
    })
  })

  it('surfaces any other inventory failure', async () => {
    await expect(
      listMemoryResources({
        inventory: () => Promise.reject(new ApiError('Forbidden', 403)),
        declarations: () => Promise.resolve([]),
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('notes limit, declaration and document count in the selector hint', () => {
    expect(memoryResourceHint(inventory[1])).toBe('8.0 KiB · 3 documents')
    expect(memoryResourceHint(inventory[0])).toBe(
      'not declared · 4.0 KiB · 2 documents',
    )
    expect(
      memoryResourceHint({
        id: 'x',
        provider: { kind: 'document' },
        declared: true,
      }),
    ).toBe('')
  })
})

describe('document presentation', () => {
  it('marks a document over its resource limit', () => {
    expect(isOverMemoryLimit({ bytes: 8193, maxBytes: 8192 })).toBe(true)
    expect(isOverMemoryLimit({ bytes: 8192, maxBytes: 8192 })).toBe(false)
  })

  it('names the last writer', () => {
    expect(memoryWriterLabel({ kind: 'owner' })).toBe('Owner')
    expect(memoryWriterLabel({ kind: 'agent', sessionId: 'ses_1' })).toBe(
      'Agent ses_1',
    )
  })

  it('formats sizes', () => {
    expect(formatMemoryBytes(33)).toBe('33 B')
    expect(formatMemoryBytes(8192)).toBe('8.0 KiB')
  })
})

describe('memoryExportFile', () => {
  it('names the file by resource and environment and keeps document fields', () => {
    const document = {
      id: 'workshop',
      title: 'Workshop requirements',
      text: 'Node.js 22.',
      summary: '',
      agentWrites: 'enabled' as const,
      revision: 'rev-1',
      bytes: 11,
      maxBytes: 8192,
      updatedAt: '2026-09-10T12:00:00.000Z',
      writer: { kind: 'owner' as const },
    }
    const file = memoryExportFile({
      resource: 'requirements',
      environment: 'development',
      documents: [document],
      exportedAt: new Date('2026-09-10T13:00:00.000Z'),
    })
    expect(file.name).toBe('memory-requirements-development.json')
    expect(JSON.parse(file.body)).toEqual({
      resource: 'requirements',
      environment: 'development',
      exportedAt: '2026-09-10T13:00:00.000Z',
      documents: [document],
    })
    expect(file.body.endsWith('\n')).toBe(true)
  })
})
