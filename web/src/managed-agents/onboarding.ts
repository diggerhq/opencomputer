function shellArgument(value: string) {
  return /^[a-zA-Z0-9._:/-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}

export function createStartCommand(directory: string) {
  return `npx @opencomputer/cli init ${shellArgument(directory)}`
}

export function linkProjectCommand(project: string) {
  return `npx @opencomputer/cli link --project ${shellArgument(project)}`
}

/**
 * The shell steps that take a fresh checkout to its first Development
 * deployment. `init` writes local source only, so the checkout must be linked
 * to the existing cloud project before `deploy` runs.
 */
export function starterCommands(directory: string, project: string) {
  return [
    createStartCommand(directory),
    `cd ${shellArgument(directory)}`,
    'npm install',
    linkProjectCommand(project),
    'npm run deploy -- --watch',
  ]
}

export function starterCommandBlock(directory: string, project: string) {
  return starterCommands(directory, project).join('\n')
}

export function starterCopyCommand(directory: string, project: string) {
  return starterCommands(directory, project).join(' && ')
}
