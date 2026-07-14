import { describe, expect, it } from 'vitest'
import {
  AgentDeploymentCommandResponseSchema,
  AgentDeploymentListSchema,
  AgentDeploymentLogsSchema,
  AgentDeploymentSchema,
  DeployAppSchema,
} from './schemas'

const deployment = {
  id: 'dep_0123456789abcdef01234567',
  state: 'building',
  phase: 'build',
  terminal: false,
  result: null,
  input_type: 'github',
  revision_id: null,
  revision: null,
  source: {
    via: 'repo',
    repo_id: 'repo_0123456789abcdef01234567',
    path: '',
    git_sha: 'a'.repeat(40),
  },
  source_relation: {
    repo: {
      id: 'repo_0123456789abcdef01234567',
      full_name: 'example/flue-agent',
    },
    path: '',
    production_ref: 'main',
    status: 'active',
    ref: 'main',
    sha: 'a'.repeat(40),
    commit_url: `https://github.com/example/flue-agent/commit/${'a'.repeat(40)}`,
  },
  actor: { kind: 'human', id: 'user_123' },
  ref: 'main',
  sha: 'a'.repeat(40),
  error_class: null,
  error: null,
  build: {
    schema_version: 1,
    attempts: 1,
    root: '',
    node: '22.19.0',
    source_bytes: 42,
    source_files: 3,
  },
  configuration: {
    entrypoint: 'support-triage',
    model: 'anthropic/claude-haiku-4-5',
    runtime: { family: 'flue', type: 'default' },
    variable_names: ['REGION'],
  },
  log_bytes: 86,
  log_truncated: false,
  live_touched: false,
  agent_live: null,
  restore_eligibility: 'none',
  redeploy_of: null,
  allowed_actions: ['view_commit'],
  active: false,
  timing: {
    accepted_at: '2026-07-14T20:00:00.000Z',
    started_at: '2026-07-14T20:00:01.000Z',
    finished_at: null,
    cancel_requested_at: null,
    queue_ms: 1_000,
    run_ms: null,
    total_ms: null,
  },
  created_at: '2026-07-14T20:00:00.000Z',
  updated_at: '2026-07-14T20:00:02.000Z',
  started_at: '2026-07-14T20:00:01.000Z',
  finished_at: null,
}

describe('repository deployment API schemas', () => {
  it('accepts the frozen deployment read model and ignores additive fields', () => {
    const parsed = AgentDeploymentSchema.parse({
      ...deployment,
      future_server_field: { safe: true },
    })

    expect(parsed.state).toBe('building')
    expect(parsed.source_relation?.repo?.full_name).toBe('example/flue-agent')
    expect('future_server_field' in parsed).toBe(false)
  })

  it('keeps deployment-log sequence identity as an opaque string', () => {
    const seq = '900719925474099312345'
    const parsed = AgentDeploymentLogsSchema.parse({
      data: [
        {
          seq,
          cursor: 'opaque-cursor',
          recorded_at: '2026-07-14T20:00:02.000Z',
          phase: 'build',
          stream: 'stdout',
          chunk: 'building',
        },
      ],
      next_cursor: 'opaque-cursor',
      has_more: false,
    })

    expect(parsed.data[0]?.seq).toBe(seq)
  })

  it('parses the exact cursor envelope for deployment history', () => {
    const parsed = AgentDeploymentListSchema.parse({
      data: [deployment],
      next_cursor: 'opaque-history-cursor',
    })

    expect(parsed.data[0]?.id).toBe(deployment.id)
    expect(parsed.next_cursor).toBe('opaque-history-cursor')
    expect(() =>
      AgentDeploymentListSchema.parse({ data: [deployment] }),
    ).toThrow()
  })

  it('requires the deployment id returned by a deploy command', () => {
    const response = {
      deployment: {
        id: 'dep_0123456789abcdef01234567',
        state: 'accepted',
        revision_id: null,
        active: false,
      },
    }

    expect(
      AgentDeploymentCommandResponseSchema.parse(response).deployment.id,
    ).toBe(response.deployment.id)
    expect(() =>
      AgentDeploymentCommandResponseSchema.parse({
        deployment: { ...response.deployment, id: undefined },
      }),
    ).toThrow()
  })

  it('filters repositories without a registered import coordinate safely', () => {
    const parsed = DeployAppSchema.parse({
      installed: true,
      install_url: null,
      configure_url: null,
      account: 'example',
      repository_selection: 'selected',
      repositories: [
        {
          id: null,
          full_name: 'example/pending-registration',
          default_branch: 'main',
          private: true,
        },
      ],
    })

    expect(parsed.repositories[0]?.id).toBeNull()
  })

  it('fails closed when deployment identity or canonical state is absent', () => {
    const withoutState = { ...deployment } as Partial<typeof deployment>
    delete withoutState.state
    expect(() => AgentDeploymentSchema.parse(withoutState)).toThrow()
  })
})
