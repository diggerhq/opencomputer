import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, RefreshCw, Unplug } from 'lucide-react'
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
  getManagedModelAccessBindings,
  getManagedModelAccessConnections,
  putManagedModelAccessBinding,
  validateManagedModelAccessConnection,
} from './api'

export const MODEL_ACCESS_RETURN_TO_KEY = 'opencomputer:model-access:return-to'

type Environment = 'development' | 'production'

const environments: Environment[] = ['development', 'production']

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
  const [confirmProduction, setConfirmProduction] =
    useState<Environment | null>(null)
  const canManageConnection = user?.capabilities?.manageMembers !== false
  const cliExecutable =
    window.location.hostname === 'mo-oc-dev.com' ? 'ocdev' : 'opencomputer'
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

  const isEnabled = (environment: Environment) => {
    const binding = bindings.data?.find(
      (candidate) =>
        candidate.provider === 'openai' &&
        candidate.environment === environment,
    )
    return Boolean(
      codex?.status === 'connected' &&
      binding?.enabled &&
      binding.connectionId === codex.id,
    )
  }

  const connect = useMutation({
    mutationFn: connectManagedModelAccess,
    onSuccess: (receipt) => {
      sessionStorage.setItem(
        MODEL_ACCESS_RETURN_TO_KEY,
        `${location.pathname}${location.search}`,
      )
      window.location.assign(receipt.authorize_url)
    },
    onError: (error) =>
      notifyError("Couldn't start Codex authorization.", error),
  })
  const updateBinding = useMutation({
    mutationFn: ({
      environment,
      enabled,
    }: {
      environment: Environment
      enabled: boolean
    }) => putManagedModelAccessBinding({ projectId, environment, enabled }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: bindingQueryKey })
      notifySuccess(
        updated.enabled
          ? `Codex subscription enabled for ${updated.environment}.`
          : `Managed inference restored for ${updated.environment}.`,
      )
    },
    onError: (error) =>
      notifyError("Couldn't update model access for this project.", error),
  })
  const validateConnection = useMutation({
    mutationFn: () => validateManagedModelAccessConnection(codex!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: connectionQueryKey })
      notifySuccess('Codex subscription revalidated.')
    },
    onError: (error) =>
      notifyError("Couldn't revalidate the Codex subscription.", error),
  })
  const disconnectConnection = useMutation({
    mutationFn: () => disconnectManagedModelAccessConnection(codex!.id),
    onSuccess: async () => {
      setConfirmDisconnect(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: connectionQueryKey }),
        queryClient.invalidateQueries({ queryKey: bindingQueryKey }),
      ])
      notifySuccess('Codex subscription disconnected.')
    },
    onError: (error) =>
      notifyError("Couldn't disconnect the Codex subscription.", error),
  })

  const startConnect = () => {
    setConfirmReplace(false)
    connect.mutate()
  }
  const setEnvironmentEnabled = (
    environment: Environment,
    enabled: boolean,
  ) => {
    setConfirmProduction(null)
    updateBinding.mutate({ environment, enabled })
  }

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
          icon={KeyRound}
          title="BYOK status is temporarily unavailable"
          description="Try loading the project again."
          action={
            <Button
              variant="outline"
              onClick={() => {
                void connections.refetch()
                void bindings.refetch()
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
              Link your organization&apos;s Codex subscription, then configure
              this project&apos;s development and production routing. Managed
              usage-based inference remains the fallback. Runtime compute is
              still charged.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-6">
          <div>
            <p className="text-muted-foreground text-xs font-medium uppercase">
              Organization subscription
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Codex subscription</span>
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
                ? `${codex.label}${codex.checkedAt ? ` · checked ${new Date(codex.checkedAt).toLocaleString()}` : ''}`
                : 'No Codex subscription is linked to this organization.'}
            </p>
          </div>

          <div className="grid gap-4 border-t pt-5 md:grid-cols-2">
            {environments.map((environment) => {
              const enabled = isEnabled(environment)
              return (
                <div
                  key={environment}
                  className="bg-panel-2 rounded-lg border p-4"
                >
                  <p className="text-xs font-medium capitalize">
                    {environment}
                  </p>
                  <div className="mt-2">
                    <StatusBadge
                      status={enabled ? 'running' : 'stopped'}
                      label={
                        enabled
                          ? 'Subscription preferred · Managed fallback'
                          : 'Managed'
                      }
                    />
                  </div>
                  <p className="text-muted-foreground mt-2 text-sm">
                    {enabled
                      ? 'Model calls prefer the linked subscription.'
                      : 'Model calls use OpenComputer managed inference.'}
                  </p>
                  {codex?.status === 'connected' ? (
                    <Button
                      className="mt-4"
                      size="sm"
                      variant={enabled ? 'outline' : 'default'}
                      disabled={updateBinding.isPending}
                      onClick={() => {
                        if (enabled) setEnvironmentEnabled(environment, false)
                        else if (environment === 'production')
                          setConfirmProduction(environment)
                        else setEnvironmentEnabled(environment, true)
                      }}
                    >
                      {updateBinding.isPending ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      {enabled ? 'Use Managed' : 'Use subscription'}
                    </Button>
                  ) : null}
                </div>
              )
            })}
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
                  <KeyRound />
                )}
                {codex ? 'Replace subscription' : 'Connect subscription'}
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
              Ask an organization admin to connect a Codex subscription.
            </p>
          ) : null}
        </PanelContent>
      </Panel>

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Use the subscription in agent code</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Select the OpenAI provider explicitly. The shorter string form is
              an OpenRouter catalog model and continues to use Managed access.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">
              Codex subscription eligible
            </p>
            <CopyRow
              value={'useModel({ provider: "openai", model: "gpt-5" })'}
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Managed OpenRouter</p>
            <CopyRow value={'useModel("openai/gpt-5")'} />
          </div>
        </PanelContent>
      </Panel>

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Connect with the CLI</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Each command opens the Codex OAuth flow, links or replaces the
              organization subscription, and enables it for this project in one
              run.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-4">
          {(
            [
              ['Development', 'development'],
              ['Production', 'production'],
              ['Development and production', 'both'],
            ] as const
          ).map(([label, environment]) => (
            <div key={environment}>
              <p className="mb-2 text-sm font-medium">{label}</p>
              <CopyRow
                value={`${cliExecutable} model-access connect codex --project ${projectSlug} --environment ${environment}`}
              />
            </div>
          ))}
        </PanelContent>
      </Panel>

      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        title="Replace the organization subscription?"
        description="This reconnects the organization-owned Codex subscription and affects every project environment currently using it."
        confirmLabel="Continue to OpenAI"
        onConfirm={startConnect}
      />
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect the organization subscription?"
        description="Every project environment using this subscription will return to Managed inference."
        confirmLabel="Disconnect subscription"
        onConfirm={() => disconnectConnection.mutate()}
      />
      <ConfirmDialog
        open={confirmProduction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmProduction(null)
        }}
        title="Enable the subscription in production?"
        description="Production model calls will prefer the Codex subscription and fall back to Managed inference when necessary."
        confirmLabel="Enable in production"
        onConfirm={() => setEnvironmentEnabled('production', true)}
      />
    </div>
  )
}
