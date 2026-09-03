export const HELLO_WORLD_TEMPLATE_REPOSITORY =
  'https://github.com/diggerhq/opencomputer-example-hello-world'

export const CURATED_TEMPLATES = [
  {
    name: 'Pull Request Reviewer',
    description:
      'Review a pull request and return focused, actionable feedback.',
    repositoryUrl: 'https://github.com/diggerhq/opencomputer-example-pr-review',
  },
  {
    name: 'Test Coverage',
    description: 'Find meaningful gaps in a repository’s automated tests.',
    repositoryUrl:
      'https://github.com/diggerhq/opencomputer-example-test-coverage',
  },
  {
    name: 'GitHub Actions Triage',
    description: 'Investigate failed CI runs and explain the likely fix.',
    repositoryUrl:
      'https://github.com/diggerhq/opencomputer-example-actions-triage',
  },
  {
    name: 'Feature Flag Hygiene',
    description: 'Audit stale feature flags across GitHub and Unleash.',
    repositoryUrl: 'https://github.com/diggerhq/opencomputer-example-unleash',
  },
  {
    name: 'GTM Engineer',
    description: 'Turn product context into practical go-to-market work.',
    repositoryUrl: 'https://github.com/diggerhq/opencomputer-example-gtm',
  },
] as const

export function templateDeployPath(repositoryUrl: string, quickStart = false) {
  const query = new URLSearchParams({ 'repository-url': repositoryUrl })
  if (quickStart) query.set('quick-start', '1')
  return `/new?${query.toString()}`
}
