import { describe, expect, it } from 'vitest'
import {
  declaredMemoryResources,
  formatMemoryBytes,
  isOverMemoryLimit,
  memoryExportFile,
  memoryWriterLabel,
} from './memory-documents'

const requirements = {
  id: 'requirements',
  description: 'Verified requirements.',
  provider: { kind: 'document', maxBytes: 8192 },
}

describe('declaredMemoryResources', () => {
  it('merges declarations across deployments by id, first wins, sorted', () => {
    expect(
      declaredMemoryResources([
        { memory: [{ ...requirements, id: 'notes' }, requirements] },
        undefined,
        {
          memory: [
            { ...requirements, description: 'A later duplicate.' },
            { ...requirements, id: 'budget' },
          ],
        },
      ]).map((declaration) => [declaration.id, declaration.description]),
    ).toEqual([
      ['budget', 'Verified requirements.'],
      ['notes', 'Verified requirements.'],
      ['requirements', 'Verified requirements.'],
    ])
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
