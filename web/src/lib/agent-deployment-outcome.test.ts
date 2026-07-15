import { describe, expect, it } from 'vitest'
import type { AgentDeployment } from '@/api/client'
import { agentDeploymentOutcome } from './agent-deployment-outcome'

function deployment(patch: Partial<AgentDeployment> = {}): AgentDeployment {
  return {
    id: 'dep_old',
    state: 'failed',
    phase: 'Deploy',
    terminal: true,
    result: 'failed',
    input_type: 'github',
    revision_id: null,
    revision: null,
    source: null,
    source_relation: null,
    actor: null,
    ref: 'main',
    sha: 'a'.repeat(40),
    error: null,
    error_class: 'deploy_failed',
    build: null,
    configuration: null,
    log_bytes: 0,
    log_truncated: false,
    live_touched: true,
    agent_live: null,
    restore_eligibility: 'none',
    redeploy_of: null,
    allowed_actions: [],
    active: false,
    timing: {
      accepted_at: null,
      started_at: null,
      finished_at: null,
      cancel_requested_at: null,
      queue_ms: null,
      run_ms: null,
      total_ms: null,
    },
    created_at: '2026-07-14T00:00:00Z',
    updated_at: '2026-07-14T00:00:00Z',
    started_at: null,
    finished_at: null,
    ...patch,
  }
}

describe('agentDeploymentOutcome', () => {
  it('does not call a recovered historical failure currently unverified', () => {
    const result = agentDeploymentOutcome(
      deployment({
        agent_live: {
          deployment_id: 'dep_new',
          status: 'verified',
        },
      }),
    )
    expect(result.title).toBe('Deployment failed')
    expect(result.description).toContain('later verified deployment')
  })

  it('does not call an inactive historical success ready to run', () => {
    const result = agentDeploymentOutcome(
      deployment({
        state: 'ready',
        result: 'ready',
        revision: {
          id: 'rev_old',
          number: 1,
          digest: 'sha256:old',
          created_at: '2026-07-14T00:00:00Z',
        },
        agent_live: {
          deployment_id: 'dep_new',
          status: 'verified',
        },
      }),
    )
    expect(result.title).toBe('Deployment succeeded')
    expect(result.description).toContain('another revision is active')
  })

  it('calls only an active, startable revision ready', () => {
    const result = agentDeploymentOutcome(
      deployment({
        state: 'ready',
        result: 'ready',
        active: true,
        allowed_actions: ['start_session'],
        agent_live: {
          deployment_id: 'dep_old',
          status: 'verified',
        },
      }),
    )
    expect(result.kind).toBe('success')
    expect(result.title).toBe('Deployment ready')
  })
})
