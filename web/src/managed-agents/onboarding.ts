function shellArgument(value: string) {
  return /^[a-zA-Z0-9._:/-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}

export function createStartCommand(directory: string) {
  return `npm create @opencomputer/start@latest ${shellArgument(directory)}`
}

export function starterCommands(directory: string) {
  return [createStartCommand(directory), 'npm i', 'npm run dev']
}
