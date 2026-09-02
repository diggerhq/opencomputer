function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`
}

export function templateCloneCommand(input: {
  repositoryUrl: string
  commitSha: string
  projectId: string
}): string {
  return [
    'npx --package @opencomputer/cli opencomputer template clone',
    shellQuote(input.repositoryUrl),
    '--commit',
    shellQuote(input.commitSha),
    '--project',
    shellQuote(input.projectId),
  ].join(' ')
}
