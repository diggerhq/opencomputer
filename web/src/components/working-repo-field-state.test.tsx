// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepositoryAccess } from '@/api/client'
import { repositoryAccessQueryKey } from '@/lib/repository-access'
import { WorkingRepoField, type WorkingRepo } from './working-repo-field'

const agentA = 'agt_aaaaaaaaaaaaaaaaaaaaaaaa'
const agentB = 'agt_bbbbbbbbbbbbbbbbbbbbbbbb'
const value: WorkingRepo = {
  repo: 'repo_1',
  fullName: 'acme/app',
  ref: 'main',
}

function access(
  repositories: RepositoryAccess['effective_repositories'],
  truncated = false,
): RepositoryAccess {
  return {
    policy: { mode: 'all' },
    grant: {
      status: repositories === null ? 'unavailable' : 'active',
      account: 'acme',
      repository_selection: 'all',
      install_url: 'https://github.test/install',
      configure_url: 'https://github.test/configure',
      truncated,
    },
    effective_repositories: repositories,
    unavailable_selected_repositories: [],
  }
}

const repository = {
  id: 'repo_1',
  full_name: 'acme/app',
  default_branch: 'main',
  private: true,
}

describe('WorkingRepoField selection validity', () => {
  let container: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean
      }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(repositoryAccessQueryKey(agentA), access([repository]))
    client.setQueryData(repositoryAccessQueryKey(agentB), access([repository]))
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
  })

  function renderField(
    agentId: string,
    onChange: (next: WorkingRepo | null) => void,
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <WorkingRepoField
            agentId={agentId}
            runtime="flue"
            value={value}
            onChange={onChange}
          />
        </QueryClientProvider>,
      )
    })
  }

  it('clears a selection immediately when the agent scope changes', () => {
    const onChange = vi.fn()
    renderField(agentA, onChange)
    expect(onChange).not.toHaveBeenCalled()

    renderField(agentB, onChange)
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('clears a selection removed from the loaded effective policy', () => {
    const onChange = vi.fn()
    renderField(agentA, onChange)

    act(() => {
      client.setQueryData(repositoryAccessQueryKey(agentA), access([]))
    })
    renderField(agentA, onChange)

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('keeps the selection when an unavailable grant makes the set unknown', () => {
    const onChange = vi.fn()
    renderField(agentA, onChange)

    act(() => {
      client.setQueryData(repositoryAccessQueryKey(agentA), access(null))
    })
    renderField(agentA, onChange)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the selection when a truncated grant makes absence ambiguous', () => {
    const onChange = vi.fn()
    renderField(agentA, onChange)

    act(() => {
      client.setQueryData(repositoryAccessQueryKey(agentA), access([], true))
    })
    renderField(agentA, onChange)

    expect(onChange).not.toHaveBeenCalled()
  })
})
