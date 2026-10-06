import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, Loader2, Unplug } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { Label, Select } from '@/components/form'
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
  attachManagedGitHub,
  connectManagedGitHub,
  disconnectManagedGitHub,
  getManagedGitHubStatus,
} from './api'
import { launchAuthorizationWindow } from './authorization-window'
import {
  githubConnectionDetails,
  githubConnectionLabel,
} from './github-connection'

export function ManagedProjectGitHub({
  projectId,
  environment,
}: {
  projectId: string
  environment: 'default' | 'development' | 'production'
}) {
  const queryClient = useQueryClient()
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [addingConnection, setAddingConnection] = useState(false)
  const queryKey = ['managed-github', projectId]
  const status = useQuery({
    queryKey,
    queryFn: () => getManagedGitHubStatus(projectId),
  })
  const current = status.data?.environments.find(
    (candidate) => candidate.environment === environment,
  )
  const availableConnections = (status.data?.connections ?? []).filter(
    (connection) => connection.state === 'active',
  )
  const selectedConnection =
    availableConnections.find(
      (connection) => connection.id === selectedConnectionId,
    ) ?? availableConnections[0]
  const connectionId = selectedConnection?.id ?? ''
  const attach = useMutation({
    mutationFn: () =>
      attachManagedGitHub({ projectId, environment, connectionId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
      notifySuccess(`GitHub attached to ${environment}.`)
    },
    onError: (error) =>
      notifyError("Couldn't attach the GitHub connection.", error),
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
              {availableConnections.length ? (
                <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0 flex-1 sm:max-w-md">
                    <Label htmlFor={`github-connection-${environment}`}>
                      GitHub organization
                    </Label>
                    <Select
                      id={`github-connection-${environment}`}
                      value={connectionId}
                      onValueChange={setSelectedConnectionId}
                      options={availableConnections.map((connection) => ({
                        value: connection.id,
                        label: githubConnectionLabel(connection),
                        hint:
                          connection.repositorySelection === 'all'
                            ? 'All repositories'
                            : 'Selected repositories',
                      }))}
                      className="mt-1.5 h-9"
                    />
                    {selectedConnection ? (
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        {githubConnectionDetails(selectedConnection)}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    className="sm:shrink-0"
                    disabled={!connectionId || attach.isPending}
                    onClick={() => attach.mutate()}
                  >
                    {attach.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <GithubMark className="size-4" />
                    )}
                    Attach
                  </Button>
                </div>
              ) : (
                <Button
                  disabled={addingConnection}
                  onClick={() => {
                    setAddingConnection(true)
                    void launchAuthorizationWindow(() =>
                      connectManagedGitHub({
                        projectId,
                        environments: [environment],
                      }).then((connection) => connection.installUrl),
                    )
                      .catch((error: unknown) =>
                        notifyError(
                          "Couldn't start the GitHub installation.",
                          error,
                        ),
                      )
                      .finally(() => setAddingConnection(false))
                  }}
                >
                  {addingConnection ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <GithubMark className="size-4" />
                  )}
                  Add GitHub connection
                </Button>
              )}
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
