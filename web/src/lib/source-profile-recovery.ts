import type { DeploymentSource } from '@/api/schemas'

export function sourceChangesUrl(
  source: Pick<DeploymentSource, 'full_name' | 'latest_seen_sha'>,
): string | undefined {
  const parts = source.full_name?.split('/') ?? []
  if (parts.length !== 2 || parts.some((part) => !part)) return
  const repositoryUrl = `https://github.com/${parts.map(encodeURIComponent).join('/')}`
  return source.latest_seen_sha &&
    /^[0-9a-f]{40}$/i.test(source.latest_seen_sha)
    ? `${repositoryUrl}/commit/${source.latest_seen_sha}`
    : repositoryUrl
}
