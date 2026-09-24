import { describe, expect, it } from 'vitest'
import {
  CURATED_TEMPLATES,
  HELLO_WORLD_TEMPLATE_REPOSITORY,
  templateDeployPath,
  templateDeployPathFromSearch,
} from './templates'

describe('project creation templates', () => {
  it('keeps Hello World on the ordinary main-branch template path', () => {
    expect(templateDeployPath(HELLO_WORLD_TEMPLATE_REPOSITORY, true)).toBe(
      '/template?repository-url=https%3A%2F%2Fgithub.com%2Fdiggerhq%2Fopencomputer-example-hello-world&quick-start=1',
    )
  })

  it('sends public /new?repository-url links to the template deploy form', () => {
    expect(
      templateDeployPathFromSearch(
        new URLSearchParams(
          'repository-url=https%3A%2F%2Fgithub.com%2Fdiggerhq%2Fshipvideo',
        ),
      ),
    ).toBe(
      '/template?repository-url=https%3A%2F%2Fgithub.com%2Fdiggerhq%2Fshipvideo',
    )
    expect(templateDeployPathFromSearch(new URLSearchParams())).toBeNull()
  })

  it('includes each documented example once', () => {
    expect(CURATED_TEMPLATES.map((template) => template.name)).toEqual([
      'Pull Request Reviewer',
      'Test Coverage',
      'Feature Flag Hygiene',
      'GTM Engineer',
    ])
    expect(
      new Set(CURATED_TEMPLATES.map((template) => template.repositoryUrl)).size,
    ).toBe(CURATED_TEMPLATES.length)
  })
})
