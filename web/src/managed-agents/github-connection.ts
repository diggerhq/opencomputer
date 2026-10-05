export function githubConnectionLabel(connection: { accountLogin: string }) {
  return connection.accountLogin
}

export function githubConnectionDetails(connection: {
  githubInstallationId: number
  repositorySelection: 'all' | 'selected'
}) {
  const repositories =
    connection.repositorySelection === 'all'
      ? 'All repositories'
      : 'Selected repositories'
  return `${repositories} · Installation ${connection.githubInstallationId}`
}
