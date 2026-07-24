import { describe, expect, it } from 'vitest'
import { RepositorySourceInspectionSchema } from './schemas'

const reviewFingerprint = `sha256:${'b'.repeat(64)}`

const common = {
  repository: {
    id: 'repo_0123456789abcdef01234567',
    full_name: 'example/agent',
    default_branch: 'main',
  },
  root: '',
  production_ref: 'main',
  sha: 'a'.repeat(40),
  review_fingerprint: reviewFingerprint,
  candidate_roots: [],
  candidate_roots_truncated: false,
}

describe('repository source inspection schema', () => {
  it('accepts a full Flue app without losing its review projection', () => {
    const parsed = RepositorySourceInspectionSchema.parse({
      ...common,
      interpretation: {
        disposition: 'exact',
        source_profile: 'flue-app-v1',
        source_profile_version: 1,
        summary: 'Flue agent detected',
        reason_code: 'flue_detected',
        assumptions: [],
        agent: { runtime: 'flue', model: 'anthropic/claude-haiku-4-5' },
      },
      profile: {
        source_profile: 'flue-app-v1',
        source_profile_version: 1,
        manifest: {
          schema_version: 1,
          entrypoint: 'support-triage',
          model: 'anthropic/claude-haiku-4-5',
          runtime: { family: 'flue', type: 'default' },
          vars: {},
        },
        package: {
          name: 'support-agent',
          node_engine: '>=22.19 <23',
          flue_cli: '^1.0.0',
        },
        lockfile: { version: 3 },
        builder: { node: '22.19.0' },
        source: { files: 12, bytes: 4096 },
        variable_names: [],
        warnings: [],
      },
    })

    expect(parsed.profile?.manifest.entrypoint).toBe('support-triage')
    expect(parsed.review_fingerprint).toBe(reviewFingerprint)
  })

  it('accepts the bounded prompt-defined Flue profile', () => {
    const parsed = RepositorySourceInspectionSchema.parse({
      ...common,
      interpretation: {
        disposition: 'exact',
        source_profile: 'flue-prompt-v1',
        source_profile_version: 1,
        summary: 'Prompt-defined Flue agent detected',
        reason_code: 'flue_prompt_detected',
        assumptions: [],
        agent: { runtime: 'flue', model: 'anthropic/claude-haiku-4-5' },
      },
      profile: {
        source_profile: 'flue-prompt-v1',
        source_profile_version: 1,
        manifest: {
          schema_version: 1,
          entrypoint: 'support-triage',
          model: 'anthropic/claude-haiku-4-5',
          runtime: { family: 'flue', type: 'default' },
          vars: {},
        },
        package: {
          name: 'opencomputer-flue-prompt-agent',
          node_engine: '>=22.19 <23',
          flue_cli: '1.0.0-beta.9',
        },
        lockfile: { version: 3 },
        builder: {
          node: '22.19.0',
          synthesis_template: 'flue-prompt-template-v1',
        },
        source: { files: 4, bytes: 2048 },
        prompt: { bytes: 256 },
        skills: { count: 2, bytes: 1024, names: ['review', 'triage'] },
        variable_names: [],
        warnings: [],
      },
    })

    expect(parsed.profile?.source_profile).toBe('flue-prompt-v1')
    if (parsed.profile?.source_profile === 'flue-prompt-v1') {
      expect(parsed.profile.skills.names).toEqual(['review', 'triage'])
      expect(parsed.profile.builder.synthesis_template).toBe(
        'flue-prompt-template-v1',
      )
    }
  })

  it('treats broken Flue and unrecognized source as review results', () => {
    const invalid = RepositorySourceInspectionSchema.parse({
      ...common,
      interpretation: {
        disposition: 'invalid',
        source_profile: 'flue-app-v1',
        source_profile_version: 1,
        summary: 'Flue manifest missing',
        reason_code: 'flue_manifest_missing',
        issues: [
          {
            code: 'flue_manifest_missing',
            message: 'Add agent.toml to this Flue root.',
          },
        ],
      },
      profile: null,
    })
    const unrecognized = RepositorySourceInspectionSchema.parse({
      ...common,
      interpretation: {
        disposition: 'unrecognized',
        source_profile: null,
        source_profile_version: null,
        summary: "We couldn't find an agent definition in this folder",
        reason_code: 'unrecognized_source',
      },
      profile: null,
      candidate_roots: [
        {
          path: 'agents/support',
          source_profile: null,
          summary: 'Agent manifest found',
          marker: 'agent.toml',
        },
        {
          path: 'apps/triage',
          source_profile: 'flue-app-v1',
          summary: 'Flue configuration found',
          marker: 'flue.config.ts',
        },
      ],
      candidate_roots_truncated: true,
    })

    expect(invalid.interpretation.disposition).toBe('invalid')
    expect(unrecognized.candidate_roots).toHaveLength(2)
    expect(unrecognized.candidate_roots_truncated).toBe(true)
  })

  it('rejects speculative profiles and fallback dispositions', () => {
    expect(() =>
      RepositorySourceInspectionSchema.parse({
        ...common,
        interpretation: {
          disposition: 'exact',
          source_profile: 'oc-soft-agent-v1',
          source_profile_version: 1,
          summary: 'Soft agent detected',
          reason_code: 'soft_agent_detected',
          assumptions: [],
          agent: { runtime: 'pi', model: 'openai/gpt-5' },
        },
        profile: null,
      }),
    ).toThrow()
    expect(() =>
      RepositorySourceInspectionSchema.parse({
        ...common,
        interpretation: {
          disposition: 'fallback',
          source_profile: null,
          source_profile_version: null,
          summary: 'Generated defaults',
          reason_code: 'fallback',
        },
        profile: null,
      }),
    ).toThrow()
  })

  it('rejects crossed invalid profile identities and malformed receipts', () => {
    const invalid = {
      ...common,
      profile: null,
      interpretation: {
        disposition: 'invalid',
        summary: 'Invalid source',
        reason_code: 'manifest_invalid',
        issues: [],
      },
    }
    expect(() =>
      RepositorySourceInspectionSchema.parse({
        ...invalid,
        interpretation: {
          ...invalid.interpretation,
          source_profile: 'flue-app-v1',
          source_profile_version: null,
        },
      }),
    ).toThrow()
    expect(() =>
      RepositorySourceInspectionSchema.parse({
        ...invalid,
        interpretation: {
          ...invalid.interpretation,
          source_profile: null,
          source_profile_version: 1,
        },
      }),
    ).toThrow()
    expect(() =>
      RepositorySourceInspectionSchema.parse({
        ...common,
        review_fingerprint: 'sha256:not-a-digest',
        profile: null,
        interpretation: {
          disposition: 'unrecognized',
          source_profile: null,
          source_profile_version: null,
          summary: 'No agent found',
          reason_code: 'unrecognized_source',
        },
      }),
    ).toThrow()
  })
})
