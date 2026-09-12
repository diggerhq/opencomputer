import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, Loader2, Unplug } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { GithubMark } from '@/components/github-mark'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  connectManagedGitHub,
  disconnectManagedGitHub,
  getManagedGitHubStatus,
} from './api'

export function ManagedProjectGitHub({
  projectId,
  environment,
}: {
  projectId: string
  environment: 'development' | 'production'
}) {
  const queryClient = useQueryClient()
  const queryKey = ['managed-github', projectId]
  const status = useQuery({
    queryKey,
    queryFn: () => getManagedGitHubStatus(projectId),
  })
  const current = status.data?.environments.find(
    (candidate) => candidate.environment === environment,
  )
  const connect = useMutation({
    mutationFn: () =>
      connectManagedGitHub({ projectId, environments: [environment] }),
    onSuccess: ({ installUrl }) => {
      window.open(installUrl, '_blank', 'noopener,noreferrer')
    },
    onError: (error) =>
      notifyError("Couldn't start the GitHub installation.", error),
  })
  const disconnect = useMutation({
    mutationFn: () => disconnectManagedGitHub({ projectId, environment }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
      notifySuccess(`GitHub disconnected from ${environment}.`)
    },
    onError: (error) =>
      notifyError("Couldn't disconnect the GitHub installation.", error),
  })

  if (status.isLoading) {
    return (
      <Panel>
        <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading GitHub status…
        </PanelContent>
      </Panel>
    )
  }
  if (status.isError) {
    return (
      <Panel>
        <EmptyState
          icon={GitBranch}
          title="GitHub status is temporarily unavailable"
          description="Try loading the project again."
          action={
            <Button variant="outline" onClick={() => void status.refetch()}>
              Try again
            </Button>
          }
        />
      </Panel>
    )
  }

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>GitHub</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Install the managed OpenComputer GitHub App and choose the
              repositories it can access in GitHub. The installation’s
              repository selection is the complete repository scope.
            </PanelDescription>
          </div>
          <StatusBadge
            status={current?.state === 'active' ? 'running' : 'stopped'}
          />
        </PanelHeader>
        <PanelContent className="space-y-4">
          {current?.installation && current.state !== 'deleted' ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">
                  {current.installation.accountLogin}
                </p>
                <p className="text-muted-foreground mt-1 text-sm">
                  {current.installation.repositorySelection === 'all'
                    ? 'All repositories accessible to this installation'
                    : 'Only repositories selected in GitHub'}
                  {' · '}
                  {environment}
                </p>
              </div>
              <Button
                variant="outline"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                {disconnect.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Unplug />
                )}
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-muted-foreground max-w-2xl text-sm">
                No GitHub installation is connected to {environment}.
              </p>
              <Button
                disabled={!status.data?.app || connect.isPending}
                onClick={() => connect.mutate()}
              >
                {connect.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <GithubMark className="size-4" />
                )}
                Install GitHub App
              </Button>
            </div>
          )}
          {!status.data?.app ? (
            <p className="text-destructive text-sm">
              The managed GitHub App is not configured in this environment.
            </p>
          ) : null}
        </PanelContent>
      </Panel>

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Runtime credential warning</PanelTitle>
            <PanelDescription className="mt-1 max-w-3xl">
              When a deployed agent uses this connection, OpenComputer mints a
              GitHub installation token with the permissions declared in code.
              The token is available inside that agent’s sandbox for the
              operation and expires after about one hour. Code running in the
              sandbox can read it, so only install the App on repositories you
              are comfortable granting to the agent.
            </PanelDescription>
          </div>
        </PanelHeader>
      </Panel>
    </div>
  )
}
