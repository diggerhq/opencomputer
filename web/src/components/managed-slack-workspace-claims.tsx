import { useState } from 'react'
import {
  useMutation,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowRightLeft, Unplug } from 'lucide-react'
import {
  disconnectManagedSlack,
  type ManagedSlackWorkspaceConnection,
} from '@/api/client'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  managedSlackConnectionsQueryKey,
  managedSlackDisconnectCopy,
} from '@/lib/managed-slack-connections'
import { cn } from '@/lib/utils'

type ClaimsQuery = Pick<
  UseQueryResult<ManagedSlackWorkspaceConnection[]>,
  'data' | 'isLoading' | 'isError' | 'refetch'
>

export function ManagedSlackWorkspaceClaims({
  currentAgentId,
  currentAgentName,
  query,
  className,
  onMoveHere,
}: {
  currentAgentId: string
  currentAgentName: string
  query: ClaimsQuery
  className?: string
  onMoveHere?: () => void
}) {
  const queryClient = useQueryClient()
  const [disconnecting, setDisconnecting] =
    useState<ManagedSlackWorkspaceConnection | null>(null)
  const connections = (query.data ?? []).filter(
    (connection) => connection.agent.id !== currentAgentId,
  )
  const disconnectMutation = useMutation({
    mutationFn: (connection: ManagedSlackWorkspaceConnection) =>
      disconnectManagedSlack(connection.agent.id),
    onSuccess: (_result, connection) => {
      queryClient.setQueryData<ManagedSlackWorkspaceConnection[]>(
        managedSlackConnectionsQueryKey,
        (current) =>
          current?.filter(
            (candidate) => candidate.agent.id !== connection.agent.id,
          ) ?? [],
      )
      void queryClient.invalidateQueries({
        queryKey: managedSlackConnectionsQueryKey,
      })
      void queryClient.invalidateQueries({
        queryKey: ['slack', 'managed', connection.agent.id],
      })
      setDisconnecting(null)
      const workspace =
        connection.workspace?.name ||
        connection.workspace?.id ||
        'Slack workspace'
      notifySuccess(
        onMoveHere
          ? `${workspace} is ready to move from ${connection.agent.name}.`
          : `${workspace} disconnected from ${connection.agent.name}.`,
        onMoveHere
          ? `Finish authorizing it for ${currentAgentName} in Slack.`
          : `Connect Slack again to select it for ${currentAgentName}.`,
      )
      onMoveHere?.()
    },
    onError: (error) =>
      notifyError("Couldn't disconnect the Slack workspace.", error),
  })

  if (!query.isLoading && !query.isError && connections.length === 0) {
    return null
  }

  const copy = disconnecting
    ? managedSlackDisconnectCopy(disconnecting, currentAgentName, !!onMoveHere)
    : null
  const heading = query.isLoading
    ? 'Checking existing Slack workspaces'
    : query.isError
      ? 'Existing Slack connections are unavailable'
      : 'Slack workspaces already in use'
  const description = query.isLoading
    ? `Checking whether a workspace already sends messages to another agent before connecting ${currentAgentName}.`
    : query.isError
      ? 'You can retry this check or continue. Slack will verify the workspace claim again before connecting.'
      : onMoveHere
        ? `Move a workspace here, or connect a different workspace without changing these.`
        : `Disconnect a workspace before selecting it for ${currentAgentName}. You can connect a different workspace without changing these.`

  return (
    <>
      <section className={cn('border-t pt-4', className)} aria-label={heading}>
        <div>
          <p className="text-sm font-medium">{heading}</p>
          <p className="text-muted-foreground mt-0.5 max-w-xl text-xs leading-relaxed">
            {description}
          </p>
        </div>

        {query.isLoading ? (
          <div
            className="mt-3 space-y-2"
            aria-label="Checking Slack workspaces"
          >
            <Skeleton className="h-4 w-52" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : query.isError ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <div className="mt-3 divide-y">
            {connections.map((connection) => {
              const workspace =
                connection.workspace?.name ||
                connection.workspace?.id ||
                'Slack workspace'
              return (
                <div
                  key={`${connection.workspace?.id ?? connection.agent.id}:${connection.agent.id}`}
                  className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{workspace}</p>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">
                      Sends messages to {connection.agent.name}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <Button variant="outline" size="sm" asChild>
                      <Link to={`/agents/${connection.agent.id}`}>
                        Open agent
                      </Link>
                    </Button>
                    <Button
                      variant={onMoveHere ? 'outline' : 'ghost'}
                      size="sm"
                      disabled={disconnectMutation.isPending}
                      onClick={() => setDisconnecting(connection)}
                    >
                      {onMoveHere ? (
                        <ArrowRightLeft className="size-4" aria-hidden />
                      ) : (
                        <Unplug className="size-4" aria-hidden />
                      )}
                      {onMoveHere ? 'Move here' : 'Disconnect'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={disconnecting != null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null)
        }}
        title={copy?.title ?? 'Disconnect Slack workspace?'}
        description={copy?.description}
        confirmLabel={onMoveHere ? 'Continue in Slack' : 'Disconnect workspace'}
        destructive={!onMoveHere}
        pending={disconnectMutation.isPending}
        onConfirm={() => {
          if (disconnecting) disconnectMutation.mutate(disconnecting)
        }}
      />
    </>
  )
}
