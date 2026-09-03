function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`
}

export function projectCloneCommand(projectId: string): string {
  return [
    'npx --package @opencomputer/cli opencomputer project clone',
    shellQuote(projectId),
  ].join(' ')
}

export function templatePlaygroundPath(input: {
  projectId: string
  projectAgentId: string
}): string {
  return `/projects/${encodeURIComponent(input.projectId)}/playground/${encodeURIComponent(input.projectAgentId)}`
}

export function installedTemplateAgentId(input: {
  projectAgentId: string
  localAgentId?: string
  primaryLocalAgentId?: string
}): string {
  return !input.localAgentId || input.localAgentId === input.primaryLocalAgentId
    ? input.projectAgentId
    : `${input.projectAgentId}--${input.localAgentId}`
}

export function templateFirstRunPrompt(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined
  const prompt = (state as Record<string, unknown>).templateFirstRunPrompt
  return typeof prompt === 'string' && prompt.trim() ? prompt : undefined
}
