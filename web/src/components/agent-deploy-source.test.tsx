import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { DeploymentSource } from '@/api/schemas'
import { AgentDeploySource } from '@/components/agent-deploy-source'

const agentId = 'agt_aaaaaaaaaaaaaaaaaaaaaaaa'
const source: DeploymentSource = {
  agent_id: agentId,
  repo_id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
  path: '',
  production_ref: 'main',
  status: 'active',
  latest_seen_sha: 'a'.repeat(40),
  active_deployed_sha: 'a'.repeat(40),
  full_name: 'diggerhq/oc-flue-starter',
  source_profile: 'flue-app-v1',
  source_profile_version: 1,
  review_fingerprint: `sha256:${'b'.repeat(64)}`,
}

function renderPinnedSource(nextSource: DeploymentSource = source) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['agent-deploy-source', agentId], nextSource)
  queryClient.setQueryData(['deploy-app'], {
    installed: true,
    install_url: null,
    configure_url: 'https://github.com/settings/installations/123',
    account: 'diggerhq',
    repository_selection: 'selected',
    repositories: [],
  })

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentDeploySource agentId={agentId} profilePinned />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('profile-pinned repository management', () => {
  it('shows the reviewed source and safe management actions without an editable picker', () => {
    const html = renderPinnedSource()

    expect(html).toContain('Repository</h2>')
    expect(html).toContain('diggerhq/oc-flue-starter')
    expect(html).toContain('Production branch')
    expect(html).toContain('Repository root')
    expect(html).toContain('Configure GitHub')
    expect(html).toContain('Unlink repository')
    expect(html).toContain(
      'It does not delete this agent, its active revision, or its sessions.',
    )
    expect(html).not.toContain('<input')
    expect(html).not.toContain('Select a repo')
  })

  it('keeps the restore-or-unlink recovery when the pinned profile changes', () => {
    const html = renderPinnedSource({
      ...source,
      status: 'source_profile_changed',
      latest_seen_sha: 'c'.repeat(40),
    })

    expect(html).toContain(
      'This repository no longer matches the agent type it was imported as',
    )
    expect(html).toContain('View source changes')
    expect(html).toContain('Unlink source')
    expect(html).not.toContain('Configure GitHub')
  })
})
