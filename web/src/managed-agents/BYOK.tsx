import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit, Loader2, RefreshCw, Unplug } from 'lucide-react'
import { useLocation } from 'react-router-dom'
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
  connectManagedModelAccess,
  disconnectManagedModelAccessConnection,
  getManagedModelAccessConnections,
  validateManagedModelAccessConnection,
} from './api'

export const MODEL_ACCESS_RETURN_TO_KEY = 'opencomputer:model-access:return-to'
export const MODEL_ACCESS_PROJECT_KEY = 'opencomputer:model-access:project'

function connectionTone(status: string) {
  if (status === 'connected') return 'running'
  if (status === 'revoked' || status === 'unavailable') return 'stopped'
  return 'pending'
}

export function ManagedProjectBYOK({
  projectId,
  projectSlug,
}: {
  projectId: string
  projectSlug: string
}) {
  const { user } = useAuth()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const canManageConnection = user?.capabilities?.manageMembers !== false
  const cliExecutable =
    window.location.hostname === 'mo-oc-dev.com' ? 'ocdev' : 'opencomputer'
  const connectionQueryKey = ['managed-model-access-connections']
  const connections = useQuery({
    queryKey: connectionQueryKey,
    queryFn: getManagedModelAccessConnections,
  })
  const codex = connections.data?.find(
    (connection) => connection.provider === 'openai',
  )

  const connect = useMutation({
    mutationFn: connectManagedModelAccess,
    onSuccess: (receipt) => {
      sessionStorage.setItem(
        MODEL_ACCESS_RETURN_TO_KEY,
        `${location.pathname}${location.search}`,
      )
      sessionStorage.setItem(MODEL_ACCESS_PROJECT_KEY, projectId)
      window.location.assign(receipt.authorize_url)
    },
    onError: (error) =>
      notifyError("Couldn't start Codex authorization.", error),
  })
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
      await queryClient.invalidateQueries({ queryKey: connectionQueryKey })
      notifySuccess('Codex account disconnected.')
    },
    onError: (error) =>
      notifyError("Couldn't disconnect the Codex account.", error),
  })
  const startConnect = () => {
    setConfirmReplace(false)
    connect.mutate()
  }
  if (connections.isLoading) {
    return (
      <Panel>
        <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading BYOK status…
        </PanelContent>
      </Panel>
    )
  }

  if (connections.isError) {
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
              account for both development and production. Managed usage-based
              inference remains the fallback. Runtime compute is still charged.
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
          </div>

          <div className="flex flex-wrap gap-2 border-t pt-5">
            {canManageConnection ? (
              <Button
                variant={codex ? 'outline' : 'default'}
                disabled={connect.isPending}
                onClick={() =>
                  codex ? setConfirmReplace(true) : startConnect()
                }
              >
                {connect.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <BrainCircuit />
                )}
                {codex ? 'Replace Codex account' : 'Connect Codex account'}
              </Button>
            ) : null}
            {canManageConnection && codex ? (
              <>
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
              </>
            ) : null}
          </div>

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
            <PanelTitle>Connect with the CLI</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              The Codex command opens OAuth, links or replaces the account, and
              enables it for this project in both development and production.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-4">
          <CopyRow
            value={`${cliExecutable} model-access connect codex --project ${projectSlug}`}
          />
        </PanelContent>
      </Panel>

      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        title="Replace the Codex account?"
        description="This reconnects the Codex account and enables it for both environments in this project."
        confirmLabel="Continue to OpenAI"
        onConfirm={startConnect}
      />
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
