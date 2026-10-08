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

export function githubInstallationSettingsUrl(connection: {
  accountLogin: string
  accountType: string
  githubInstallationId: number
}) {
  const installation = encodeURIComponent(
    String(connection.githubInstallationId),
  )
  if (connection.accountType.toLowerCase() === 'organization') {
    return `https://github.com/organizations/${encodeURIComponent(connection.accountLogin)}/settings/installations/${installation}`
  }
  return `https://github.com/settings/installations/${installation}`
}
