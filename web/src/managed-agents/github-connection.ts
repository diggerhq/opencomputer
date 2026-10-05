export function githubConnectionLabel(connection: {
  accountLogin: string
  githubInstallationId: number
  repositorySelection: 'all' | 'selected'
}) {
  const repositories =
    connection.repositorySelection === 'all'
      ? 'all repositories'
      : 'selected repositories'
  return `${connection.accountLogin} · installation ${connection.githubInstallationId} · ${repositories}`
}
