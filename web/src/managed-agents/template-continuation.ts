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

export function templatePlaygroundPath(input: {
  projectId: string
  projectAgentId: string
}): string {
  return `/projects/${encodeURIComponent(input.projectId)}/playground/${encodeURIComponent(input.projectAgentId)}`
}
