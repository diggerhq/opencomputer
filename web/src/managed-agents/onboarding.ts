function shellArgument(value: string) {
  return /^[a-zA-Z0-9._:/-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}

export function createStartCommand(directory: string) {
  return `npx @opencomputer/cli init ${shellArgument(directory)}`
}

export const LOGIN_COMMAND =
  'npx --package @opencomputer/cli opencomputer login'

export function starterCommands(directory: string) {
  return [
    createStartCommand(directory),
    `cd ${shellArgument(directory)}`,
    'npm install',
    LOGIN_COMMAND,
    'npm run deploy -- --watch',
  ]
}

export function starterCommandBlock(directory: string) {
  return starterCommands(directory).join('\n')
}

export function starterCopyCommand(directory: string) {
  return starterCommands(directory).join(' && ')
}
