import { describe, expect, it } from 'vitest'
import {
  templateCloneCommand,
  templatePlaygroundPath,
} from './template-continuation'

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

  it('opens the installed agent in its project Debug playground', () => {
    expect(
      templatePlaygroundPath({
        projectId: 'prj/example',
        projectAgentId: 'review agent',
      }),
    ).toBe('/projects/prj%2Fexample/playground/review%20agent')
  })
})
