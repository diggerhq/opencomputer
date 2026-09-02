import { describe, expect, it } from 'vitest'
import {
  CURATED_TEMPLATES,
  HELLO_WORLD_TEMPLATE_REPOSITORY,
  templateDeployPath,
} from './templates'

describe('project creation templates', () => {
  it('keeps Hello World on the ordinary main-branch template path', () => {
    expect(templateDeployPath(HELLO_WORLD_TEMPLATE_REPOSITORY, true)).toBe(
      '/new?repository-url=https%3A%2F%2Fgithub.com%2Fdiggerhq%2Fopencomputer-example-hello-world&quick-start=1',
    )
  })

  it('includes each documented example once', () => {
    expect(CURATED_TEMPLATES.map((template) => template.name)).toEqual([
      'Pull Request Reviewer',
      'Test Coverage',
      'GitHub Actions Triage',
      'Feature Flag Hygiene',
      'GTM Engineer',
    ])
    expect(
      new Set(CURATED_TEMPLATES.map((template) => template.repositoryUrl)).size,
    ).toBe(CURATED_TEMPLATES.length)
  })
})
