import { describe, expect, it } from 'vitest'
import { ApiError, type RepositorySourceInspection } from '@/api/client'
import {
  normalizeRepositoryRoot,
  repositoryReviewPresentation,
  repositorySeedFromState,
  sourceChangedRequiresReview,
} from './repository-onboarding'

const common = {
  repository: {
    id: 'repo_0123456789abcdef01234567',
    full_name: 'example/agent',
    default_branch: 'main',
  },
  root: '',
  production_ref: 'main',
  sha: 'a'.repeat(40),
  profile: null,
  review_fingerprint: `sha256:${'b'.repeat(64)}`,
  candidate_roots: [],
  candidate_roots_truncated: false,
} satisfies Omit<RepositorySourceInspection, 'interpretation' | 'profile'> & {
  profile: null
}

describe('repository onboarding presentation', () => {
  it('matches linked roots after harmless path formatting differences', () => {
    expect(normalizeRepositoryRoot('  agents//support/ ')).toBe(
      'agents/support',
    )
    expect(normalizeRepositoryRoot('')).toBe('')
  })

  it('keeps invalid Flue authoritative and recoverable by re-review', () => {
    const presentation = repositoryReviewPresentation({
      ...common,
      interpretation: {
        disposition: 'invalid',
        source_profile: 'flue-app-v1',
        source_profile_version: 1,
        summary: 'Flue manifest is missing',
        reason_code: 'flue_manifest_missing',
        issues: [
          {
            code: 'flue_manifest_missing',
            message: 'Add agent.toml to this Flue root.',
          },
        ],
      },
    })

    expect(presentation).toMatchObject({
      heading: 'This Flue agent needs a fix',
      primaryAction: 'review_again',
    })
  })

  it('offers explicit candidate selection without auto-selecting a root', () => {
    const presentation = repositoryReviewPresentation({
      ...common,
      interpretation: {
        disposition: 'unrecognized',
        source_profile: null,
        source_profile_version: null,
        summary: "We couldn't find an agent definition in this folder",
        reason_code: 'unrecognized_source',
      },
      candidate_roots: [
        {
          path: 'agents/support',
          source_profile: null,
          summary: 'Agent manifest found',
          marker: 'agent.toml',
        },
      ],
    })

    expect(presentation).toEqual({
      heading: 'Agent definitions found in other folders',
      explanation:
        'Choose a repository root to review. OpenComputer will never select one for you.',
      primaryAction: 'choose_folder',
    })
  })

  it('explains how to make an unrecognized folder deployable', () => {
    const presentation = repositoryReviewPresentation({
      ...common,
      interpretation: {
        disposition: 'unrecognized',
        source_profile: null,
        source_profile_version: null,
        summary: "We couldn't find an agent definition in this folder",
        reason_code: 'unrecognized_source',
      },
    })

    expect(presentation.explanation).toContain('agent.toml')
  })

  it('presents an exact prompt-defined Flue agent without implying source code', () => {
    const presentation = repositoryReviewPresentation({
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
          entrypoint: 'support',
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
        source: { files: 3, bytes: 1024 },
        prompt: { bytes: 128 },
        skills: { count: 1, bytes: 512, names: ['triage'] },
        variable_names: [],
        warnings: [],
      },
    })

    expect(presentation).toEqual({
      heading: 'Prompt-defined Flue agent',
      explanation:
        'OpenComputer will turn this prompt and its skills into a Flue app at build time.',
      primaryAction: 'deploy',
    })
  })

  it('requires a fresh review for the typed source-change conflict', () => {
    expect(
      sourceChangedRequiresReview(
        new ApiError('Repository changed', 409, 'source_changed_re_review'),
      ),
    ).toBe(true)
    expect(
      sourceChangedRequiresReview(
        new ApiError('Conflict', 409, 'name_conflict'),
      ),
    ).toBe(false)
  })

  it('accepts only a bounded same-origin source handoff', () => {
    const seed = {
      repo: 'repo_0123456789abcdef01234567',
      path: 'agents/support',
      productionRef: 'main',
    }
    expect(repositorySeedFromState({ repositoryImport: seed })).toEqual(seed)
    expect(
      repositorySeedFromState({
        repositoryImport: { ...seed, path: '../other-agent' },
      }),
    ).toBeUndefined()
    expect(
      repositorySeedFromState({
        repositoryImport: { ...seed, repo: 'example/support' },
      }),
    ).toBeUndefined()
  })
})
