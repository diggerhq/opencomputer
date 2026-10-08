type DeploymentAlias = {
  agentId: string
  alias: string
}

type PreviewBuild = {
  alias: string
  state: string
}

/**
 * A ready project preview publishes its alias for every project member, even
 * when an unchanged member reuses an older immutable deployment row whose
 * original alias was development. Prefer the project build as the authority;
 * retain the deployment-row check for previews published outside Git deploys.
 */
export function projectAgentPreviewReady(input: {
  alias: string | undefined
  agentId: string
  deployments: readonly DeploymentAlias[]
  previews: readonly PreviewBuild[]
}): boolean {
  if (!input.alias) return false
  return (
    input.previews.some(
      (preview) => preview.alias === input.alias && preview.state === 'ready',
    ) ||
    input.deployments.some(
      (deployment) =>
        deployment.agentId === input.agentId &&
        deployment.alias === input.alias,
    )
  )
}
