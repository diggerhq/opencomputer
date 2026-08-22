function shellArgument(value: string) {
  return /^[a-zA-Z0-9._:/-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}

export function createStartCommand(directory: string) {
  return `npx @opencomputer/cli init ${shellArgument(directory)}`
}

export function starterCommands(directory: string) {
  return [
    createStartCommand(directory),
    `cd ${shellArgument(directory)}`,
    'npm install',
    'npm run deploy -- --watch',
  ]
}

export function starterCommandBlock(directory: string) {
  return starterCommands(directory).join('\n')
}

export function starterCopyCommand(directory: string) {
  return starterCommands(directory).join(' && ')
}
