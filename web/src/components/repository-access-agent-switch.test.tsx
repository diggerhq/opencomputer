// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepositoryAccess } from '@/api/client'
import { repositoryAccessQueryKey } from '@/lib/repository-access'
import { RepositoryAccessPanel } from './repository-access'

const agentA = 'agt_aaaaaaaaaaaaaaaaaaaaaaaa'
const agentB = 'agt_bbbbbbbbbbbbbbbbbbbbbbbb'

const repository = {
  id: 'repo_1',
  full_name: 'acme/support-agent',
  default_branch: 'main',
  private: true,
}

function access(policy: RepositoryAccess['policy']): RepositoryAccess {
  return {
    policy,
    grant: {
      status: 'active',
      account: 'acme',
      repository_selection: 'all',
      install_url: 'https://github.test/install',
      configure_url: 'https://github.test/configure',
      truncated: false,
    },
    effective_repositories: policy.mode === 'all' ? [repository] : [],
    unavailable_selected_repositories: [],
  }
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(label),
  )
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Button not found: ${label}`)
  return match
}

function radio(container: ParentNode, label: string): HTMLInputElement {
  const match = [
    ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ].find((element) => element.closest('label')?.textContent?.includes(label))
  if (!match) throw new Error(`Radio not found: ${label}`)
  return match
}

describe('RepositoryAccessPanel agent scoping', () => {
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
    client.setQueryData(
      repositoryAccessQueryKey(agentA),
      access({ mode: 'all' }),
    )
    client.setQueryData(
      repositoryAccessQueryKey(agentB),
      access({ mode: 'selected', repository_ids: [] }),
    )
    client.setQueryData(['deploy-app'], {
      installed: true,
      install_url: 'https://github.test/install',
      configure_url: 'https://github.test/configure',
      account: 'acme',
      repository_selection: 'all',
      repositories: [repository],
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  function renderAgent(agentId: string) {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <RepositoryAccessPanel agentId={agentId} />
        </QueryClientProvider>,
      )
    })
  }

  it('discards Agent A draft, search, and confirmation when rerendered for Agent B', () => {
    renderAgent(agentA)

    const allPolicy = radio(container, 'All granted repositories')
    const selectedPolicyA = radio(container, 'Only selected repositories')
    expect(allPolicy.name).toBe(selectedPolicyA.name)
    expect(allPolicy.checked).toBe(true)
    act(() => selectedPolicyA.click())
    expect(selectedPolicyA.checked).toBe(true)
    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Find a repository"]',
    )
    expect(search).not.toBeNull()
    act(() => {
      search!.value = 'support'
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(search!.value).toBe('support')

    act(() => button(container, 'Save access').click())
    expect(document.body.textContent).toContain('Narrow repository access?')

    renderAgent(agentB)

    const selectedPolicy = radio(container, 'Only selected repositories')
    expect(selectedPolicy.checked).toBe(true)
    expect(button(container, 'Save access').disabled).toBe(true)
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Find a repository"]',
      )?.value,
    ).toBe('')
    expect(document.body.textContent).not.toContain('Narrow repository access?')
  })
})
