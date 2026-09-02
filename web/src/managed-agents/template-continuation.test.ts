import { describe, expect, it } from 'vitest'
import { templateCloneCommand } from './template-continuation'

describe('template local continuation', () => {
  it('pins the reviewed commit and existing project', () => {
    expect(
      templateCloneCommand({
        repositoryUrl: 'https://github.com/diggerhq/example',
        commitSha: 'a'.repeat(40),
        projectId: 'prj_example',
      }),
    ).toBe(
      `npx --package @opencomputer/cli opencomputer template clone 'https://github.com/diggerhq/example' --commit '${'a'.repeat(40)}' --project 'prj_example'`,
    )
  })
})
