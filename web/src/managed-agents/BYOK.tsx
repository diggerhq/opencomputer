import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit, Loader2, RefreshCw, Unplug } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyRow } from '@/components/copy-row'
import { EmptyState } from '@/components/empty-state'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  disconnectManagedModelAccessConnection,
  getManagedModelAccessConnections,
  getManagedModelAccessBindings,
  validateManagedModelAccessConnection,
} from './api'

export const MODEL_ACCESS_RETURN_TO_KEY = 'opencomputer:model-access:return-to'
export const MODEL_ACCESS_PROJECT_KEY = 'opencomputer:model-access:project'

function connectionTone(status: string) {
  if (status === 'connected') return 'running'
  if (status === 'revoked' || status === 'unavailable') return 'stopped'
  return 'pending'
}

export function modelAccessCLICommand(
  projectSlug: string,
  location: Pick<Location, 'hostname' | 'origin'>,
) {
  const apiArgument =
    location.hostname === 'app.opencomputer.dev'
      ? ''
      : ` --api-url ${location.origin}`
  return `npx --yes --package=@opencomputer/cli@latest -- opencomputer${apiArgument} model-access connect codex --project ${projectSlug}`
}

export function hasProjectCodexAccess(
  bindings:
    | Array<{
        enabled: boolean
        environment: string
        provider: string
      }>
    | undefined,
) {
  const enabled = bindings?.filter(
    (binding) => binding.provider === 'openai' && binding.enabled,
  )
  return (
    enabled?.some((binding) => binding.environment === 'development') ===
      true && enabled.some((binding) => binding.environment === 'production')
  )
}

export function ManagedProjectBYOK({
  projectId,
  projectSlug,
}: {
  projectId: string
  projectSlug: string
}) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const canManageConnection = user?.capabilities?.manageMembers !== false
  const cliCommand = modelAccessCLICommand(projectSlug, window.location)
  const connectionQueryKey = ['managed-model-access-connections']
  const bindingQueryKey = ['managed-model-access-bindings', projectId]
  const connections = useQuery({
    queryKey: connectionQueryKey,
    queryFn: getManagedModelAccessConnections,
  })
  const bindings = useQuery({
    queryKey: bindingQueryKey,
    queryFn: () => getManagedModelAccessBindings(projectId),
  })
  const codex = connections.data?.find(
    (connection) => connection.provider === 'openai',
  )
  const projectEnabled = hasProjectCodexAccess(bindings.data)
  const validateConnection = useMutation({
    mutationFn: () => validateManagedModelAccessConnection(codex!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: connectionQueryKey })
      notifySuccess('Codex account revalidated.')
    },
    onError: (error) =>
      notifyError("Couldn't revalidate the Codex account.", error),
  })
  const disconnectConnection = useMutation({
    mutationFn: () => disconnectManagedModelAccessConnection(codex!.id),
    onSuccess: async () => {
      setConfirmDisconnect(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: connectionQueryKey }),
        queryClient.invalidateQueries({ queryKey: bindingQueryKey }),
      ])
      notifySuccess('Codex account disconnected.')
    },
    onError: (error) =>
      notifyError("Couldn't disconnect the Codex account.", error),
  })
  if (connections.isLoading || bindings.isLoading) {
    return (
      <Panel>
        <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading BYOK status…
        </PanelContent>
      </Panel>
    )
  }

  if (connections.isError || bindings.isError) {
    return (
      <Panel>
        <EmptyState
          icon={BrainCircuit}
          title="BYOK status is temporarily unavailable"
          description="Try loading the project again."
          action={
            <Button
              variant="outline"
              onClick={() => {
                void connections.refetch()
              }}
            >
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
            <PanelTitle>BYOK</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Link a Codex account to this project. Connecting it enables the
              account for both development and production. Account connection
              happens through the CLI. Managed usage-based inference remains the
              fallback. Runtime compute is still charged.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-6">
          <div>
            <p className="text-muted-foreground text-xs font-medium uppercase">
              Connected accounts
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Codex account</span>
              {codex ? (
                <StatusBadge
                  status={connectionTone(codex.status)}
                  label={codex.status.replace(/_/g, ' ')}
                />
              ) : (
                <StatusBadge status="stopped" label="Not connected" />
              )}
            </div>
            <p className="text-muted-foreground mt-2 text-sm">
              {codex
                ? `Connected account${codex.checkedAt ? ` · checked ${new Date(codex.checkedAt).toLocaleString()}` : ''}`
                : 'No Codex account is linked.'}
            </p>
            <div className="mt-4">
              <p className="text-muted-foreground text-xs font-medium uppercase">
                Project access
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge
                  status={projectEnabled ? 'running' : 'stopped'}
                  label={
                    projectEnabled
                      ? 'Enabled for development and production'
                      : 'Not enabled for this project'
                  }
                />
              </div>
              {codex && !projectEnabled ? (
                <p className="text-muted-foreground mt-2 text-sm">
                  The organization account is connected, but this project will
                  use Managed inference until you run the CLI command below.
                </p>
              ) : null}
            </div>
          </div>

          {canManageConnection && codex ? (
            <div className="flex flex-wrap gap-2 border-t pt-5">
              <Button
                variant="outline"
                disabled={validateConnection.isPending}
                onClick={() => validateConnection.mutate()}
              >
                {validateConnection.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Revalidate
              </Button>
              <Button
                variant="outline"
                disabled={disconnectConnection.isPending}
                onClick={() => setConfirmDisconnect(true)}
              >
                <Unplug /> Disconnect
              </Button>
            </div>
          ) : null}

          {!canManageConnection && !codex ? (
            <p className="text-muted-foreground text-sm">
              Ask an organization admin to connect a model account.
            </p>
          ) : null}
        </PanelContent>
      </Panel>

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Use the account in agent code</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Select the model-access provider explicitly. Connected accounts
              use their native provider; Managed models use OpenRouter.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">Codex account eligible</p>
            <CopyRow
              value={'useModel({ provider: "openai", model: "gpt-5.6-sol" })'}
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">
              Managed OpenRouter · OpenAI
            </p>
            <CopyRow
              value={
                'useModel({ provider: "openrouter", model: "openai/gpt-5" })'
              }
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">
              Managed OpenRouter · Anthropic
            </p>
            <CopyRow
              value={
                'useModel({ provider: "openrouter", model: "anthropic/claude-sonnet-4.6" })'
              }
            />
          </div>
        </PanelContent>
      </Panel>

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Connect or replace with the CLI</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              The Codex command opens OAuth, links or replaces the account, and
              enables it for this project in both development and production.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-4">
          <CopyRow value={cliCommand} />
        </PanelContent>
      </Panel>
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect the Codex account?"
        description="Projects using this account will return to Managed inference."
        confirmLabel="Disconnect account"
        onConfirm={() => disconnectConnection.mutate()}
      />
    </div>
  )
}
