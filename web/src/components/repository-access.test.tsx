import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RepositoryAccess } from '@/api/client'
import { repositoryAccessQueryKey } from '@/lib/repository-access'
import {
  RepositoryAccessPanel,
  RepositoryAccessSummary,
} from './repository-access'

const agentId = 'agt_aaaaaaaaaaaaaaaaaaaaaaaa'

function renderAccess(access: RepositoryAccess, summary = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(repositoryAccessQueryKey(agentId), access)
  client.setQueryData(['deploy-app'], {
    installed: true,
    install_url: access.grant.install_url,
    configure_url: access.grant.configure_url,
    account: access.grant.account,
    repository_selection: access.grant.repository_selection,
    repositories: access.effective_repositories ?? [],
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {summary ? (
        <RepositoryAccessSummary agentId={agentId} onOpenSettings={() => {}} />
      ) : (
        <RepositoryAccessPanel agentId={agentId} />
      )}
    </QueryClientProvider>,
  )
}

const selected: RepositoryAccess = {
  policy: { mode: 'selected', repository_ids: ['repo_1'] },
  grant: {
    status: 'active',
    account: 'acme',
    repository_selection: 'selected',
    install_url: 'https://github.test/install',
    configure_url: 'https://github.test/configure',
    truncated: false,
  },
  effective_repositories: [
    {
      id: 'repo_1',
      full_name: 'acme/a-very-long-repository-name',
      default_branch: 'main',
      private: true,
    },
  ],
  unavailable_selected_repositories: [],
}

describe('repository access UI', () => {
  it('renders the default all-granted policy without requiring a save', () => {
    const html = renderAccess({ ...selected, policy: { mode: 'all' } })
    expect(html).toContain('All granted repositories')
    expect(html).toContain('Includes repositories added')
    expect(html).toContain('Save access')
    expect(html).toContain('disabled=""')
  })

  it('renders a selected policy, current repository and settings action', () => {
    const html = renderAccess(selected)
    expect(html).toContain('Only selected repositories')
    expect(html).toContain('acme/a-very-long-repository-name')
    expect(html).toContain('Configure GitHub app')
    expect(html).toContain('Save access')
  })

  it('renders selected-empty as disabled repository work', () => {
    const html = renderAccess({
      ...selected,
      policy: { mode: 'selected', repository_ids: [] },
      effective_repositories: [],
    })
    expect(html).toContain('Repository work is disabled')
    expect(html).toContain('This agent can still chat')
  })

  it('warns on a partial catalog and keeps unavailable selections visible', () => {
    const html = renderAccess({
      ...selected,
      grant: { ...selected.grant, truncated: true },
      policy: {
        mode: 'selected',
        repository_ids: ['repo_1', 'repo_hidden'],
      },
      unavailable_selected_repositories: [
        { id: 'repo_hidden', full_name: 'acme/removed' },
      ],
    })
    expect(html).toContain('partial repository list')
    expect(html).toContain('Hidden existing selections are preserved')
    expect(html).toContain('acme/removed')
    expect(html).toContain('Unavailable')
  })

  it('explains that switching from a truncated all grant is intentionally narrowing', () => {
    const html = renderAccess({
      ...selected,
      grant: { ...selected.grant, truncated: true },
      policy: { mode: 'all' },
    })
    expect(html).toContain(
      'Switching to selected access limits the agent to repositories you choose from this partial list.',
    )
    expect(html).not.toContain('Hidden existing selections are preserved')
  })

  it('distinguishes an unavailable grant from a valid empty grant', () => {
    const html = renderAccess({
      ...selected,
      grant: { ...selected.grant, status: 'unavailable' },
      effective_repositories: null,
    })
    expect(html).toContain('GitHub access is temporarily unavailable')
    expect(html).toContain('Nothing changed')
    expect(html).toContain('>Retry<')
    expect(html).not.toContain('Reconnect GitHub')
    expect(html).not.toContain('No repositories are available')
  })

  it('offers GitHub installation without making chat unavailable', () => {
    const html = renderAccess({
      ...selected,
      grant: {
        ...selected.grant,
        status: 'not_installed',
        account: null,
        repository_selection: null,
        configure_url: null,
      },
      effective_repositories: [],
    })
    expect(html).toContain('Connect GitHub to work in repositories')
    expect(html).toContain('Chat still works without GitHub')
    expect(html).toContain('>Connect GitHub<')
  })

  it('summarizes access without duplicating the full editor', () => {
    const html = renderAccess(selected, true)
    expect(html).toContain('1 selected repository')
    expect(html).toContain('Manage access')
    expect(html).not.toContain('Find a repository')
  })

  it('distinguishes an unavailable summary from a missing installation', () => {
    const html = renderAccess(
      {
        ...selected,
        grant: { ...selected.grant, status: 'unavailable' },
        effective_repositories: null,
      },
      true,
    )
    expect(html).toContain('GitHub access is unavailable')
    expect(html).not.toContain('GitHub is not connected')
  })
})
