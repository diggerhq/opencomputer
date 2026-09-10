// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ManagedMemoryDocument,
  ManagedMemoryDocumentRead,
  ManagedMemoryDocumentTarget,
} from './api'

const api = vi.hoisted(() => ({
  getManagedMemoryResources: vi.fn(),
  getManagedMemoryDocuments: vi.fn(),
  getManagedMemoryDocument: vi.fn(),
  replaceManagedMemoryDocument: vi.fn(),
  createManagedMemoryDocument: vi.fn(),
  deleteManagedMemoryDocument: vi.fn(),
  patchManagedMemoryDocument: vi.fn(),
  getManagedAgentDeployment: vi.fn(),
}))
vi.mock('./api', () => api)

// Imported after the mock so the component sees the fakes.
const { ManagedProjectMemory } = await import('./Memory')

function documentIn(resource: string, text: string): ManagedMemoryDocument {
  return {
    id: 'workshop',
    title: `${resource} workshop`,
    text,
    summary: '',
    agentWrites: 'enabled',
    // The same id and revision in both resources: a save addressed to the
    // wrong resource would pass its revision check.
    revision: 'rev-1',
    bytes: text.length,
    maxBytes: 8192,
    updatedAt: '2026-09-10T12:00:00.000Z',
    writer: { kind: 'owner' },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  )
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Button not found: ${label}`)
  return match
}

async function settle(until: () => boolean, label: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (until()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function typeInto(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ManagedProjectMemory editor target', () => {
  let container: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    api.getManagedMemoryResources.mockReset()
    api.getManagedMemoryDocuments.mockReset()
    api.getManagedMemoryDocument.mockReset()
    api.replaceManagedMemoryDocument.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  it('drops a read that resolves after the resource changed and saves to the target it read', async () => {
    api.getManagedMemoryResources.mockResolvedValue({
      resources: [
        {
          id: 'notes',
          provider: { kind: 'document', maxBytes: 8192 },
          declared: true,
          documents: 1,
        },
        {
          id: 'requirements',
          provider: { kind: 'document', maxBytes: 8192 },
          declared: true,
          documents: 1,
        },
      ],
    })
    api.getManagedMemoryDocuments.mockImplementation(
      (input: { resource: string }) => {
        const meta: Partial<ManagedMemoryDocument> = documentIn(
          input.resource,
          '',
        )
        delete meta.text
        return Promise.resolve({ documents: [meta], nextCursor: null })
      },
    )
    const notesRead = deferred<ManagedMemoryDocumentRead>()
    api.getManagedMemoryDocument.mockImplementation(
      (target: ManagedMemoryDocumentTarget) =>
        target.resource === 'notes'
          ? notesRead.promise
          : Promise.resolve({
              document: documentIn(target.resource, 'Requirements text.'),
              etag: '"rev-1"',
            }),
    )
    api.replaceManagedMemoryDocument.mockImplementation(
      (input: ManagedMemoryDocumentTarget & { text: string }) =>
        Promise.resolve({
          document: {
            ...documentIn(input.resource, input.text),
            revision: 'rev-2',
          },
          etag: '"rev-2"',
        }),
    )

    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ManagedProjectMemory
              projectId="prj_1"
              environment="development"
              deploymentIds={[]}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })

    // The first resource, notes, is selected; open its document.
    await settle(
      () => container.textContent?.includes('notes workshop') ?? false,
      'the notes documents',
    )
    act(() => button(container, 'Edit').click())
    await settle(
      () => api.getManagedMemoryDocument.mock.calls.length > 0,
      'the notes read',
    )
    expect(api.getManagedMemoryDocument).toHaveBeenCalledWith({
      projectId: 'prj_1',
      resource: 'notes',
      id: 'workshop',
      environment: 'development',
    })

    // Switch to requirements while that read is still in flight.
    const other = container.querySelector<HTMLInputElement>(
      'input[aria-label="Other resource ID"]',
    )!
    act(() => typeInto(other, 'requirements'))
    act(() => {
      other
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await settle(
      () => container.textContent?.includes('requirements workshop') ?? false,
      'the requirements documents',
    )

    // The stale read lands now: no editor opens, nothing of it is shown.
    await act(async () => {
      notesRead.resolve({
        document: documentIn('notes', 'Notes text.'),
        etag: '"rev-1"',
      })
      await notesRead.promise
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.querySelector('#memory-edit-text')).toBeNull()
    expect(document.body.textContent).not.toContain('Notes text.')

    // Editing the requirements document saves to requirements, with the
    // revision that read returned, never to the resource read first.
    act(() => button(container, 'Edit').click())
    await settle(
      () => document.body.querySelector('#memory-edit-text') !== null,
      'the requirements editor',
    )
    const text =
      document.body.querySelector<HTMLTextAreaElement>('#memory-edit-text')!
    expect(text.value).toBe('Requirements text.')
    act(() => typeInto(text, 'Requirements text, edited.'))
    act(() => button(document.body, 'Save').click())
    await settle(
      () => api.replaceManagedMemoryDocument.mock.calls.length > 0,
      'the save',
    )

    expect(api.replaceManagedMemoryDocument).toHaveBeenCalledTimes(1)
    expect(api.replaceManagedMemoryDocument).toHaveBeenCalledWith({
      projectId: 'prj_1',
      resource: 'requirements',
      id: 'workshop',
      environment: 'development',
      etag: '"rev-1"',
      text: 'Requirements text, edited.',
      summary: '',
    })
    expect(
      api.replaceManagedMemoryDocument.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as ManagedMemoryDocumentTarget).resource === 'notes',
      ),
    ).toBe(false)
  })
})
