import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BrainCircuit,
  Link2,
  Link2Off,
  LockKeyhole,
  Loader2,
  RefreshCw,
  Unplug,
} from 'lucide-react'
import { getAutumnBilling, getBilling } from '@/api/client'
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
  connectManagedModelApiKey,
  disconnectManagedModelAccessConnection,
  getManagedModelAccessConnections,
  getManagedModelAccessBindings,
  getManagedModelRoutes,
  putManagedModelRoute,
  putManagedModelAccessBinding,
  validateManagedModelAccessConnection,
} from './api'

export const MODEL_ACCESS_RETURN_TO_KEY = 'opencomputer:model-access:return-to'
export const MODEL_ACCESS_PROJECT_KEY = 'opencomputer:model-access:project'

export type ModelRouteProviderChoice =
  | 'codex'
  | 'claude'
  | 'openrouter'
  | 'openai_compatible'

export const MODEL_ROUTE_PROVIDER_DEFAULTS: Record<
  ModelRouteProviderChoice,
  { model: string; connectionProvider: string }
> = {
  codex: { model: 'gpt-5.6-sol', connectionProvider: 'openai' },
  claude: { model: 'claude-sonnet-4-6', connectionProvider: 'anthropic' },
  openrouter: {
    model: 'openai/gpt-5',
    connectionProvider: 'openrouter',
  },
  openai_compatible: { model: '', connectionProvider: 'openai_compatible' },
}
export const DEFAULT_MODEL_ROUTE_PROVIDER: ModelRouteProviderChoice = 'codex'

export function modelConnectionLabel(connection: {
  id: string
  label: string
  baseUrl?: string | null
}) {
  if (connection.baseUrl) {
    try {
      return `${connection.label} · ${new URL(connection.baseUrl).hostname}`
    } catch {
      // The API validates URLs; retain the safe label if older data does not.
    }
  }
  return connection.label || connection.id
}

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

export function projectCodexBindingUpdates(
  projectId: string,
  enabled: boolean,
) {
  return (['development', 'production'] as const).map((environment) => ({
    projectId,
    provider: 'openai' as const,
    environment,
    enabled,
  }))
}

export function hasBYOKPlanAccess(plan: string | undefined) {
  return plan === 'pro' || plan === 'max'
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
  const [apiProvider, setApiProvider] = useState<ModelRouteProviderChoice>(
    DEFAULT_MODEL_ROUTE_PROVIDER,
  )
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [routeModel, setRouteModel] = useState(
    MODEL_ROUTE_PROVIDER_DEFAULTS[DEFAULT_MODEL_ROUTE_PROVIDER].model,
  )
  const [routeFallback, setRouteFallback] = useState<'fail' | 'managed'>('fail')
  const canManageConnection = user?.capabilities?.manageMembers !== false
  const cliCommand = modelAccessCLICommand(projectSlug, window.location)
  const connectionQueryKey = ['managed-model-access-connections']
  const bindingQueryKey = ['managed-model-access-bindings', projectId]
  const routeQueryKey = ['managed-model-routes', projectId]
  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: getBilling,
  })
  const autumnBilling = useQuery({
    queryKey: ['billing', 'autumn'],
    queryFn: getAutumnBilling,
    enabled: billing.data?.billingProvider === 'autumn',
  })
  const usagePlan =
    billing.data?.billingProvider === 'autumn'
      ? autumnBilling.data?.usagePlan
      : billing.data?.plan
  const planEligible = hasBYOKPlanAccess(usagePlan)
  const billingLoading =
    billing.isLoading ||
    (billing.data?.billingProvider === 'autumn' && autumnBilling.isLoading)
  const billingError =
    billing.isError ||
    (billing.data?.billingProvider === 'autumn' && autumnBilling.isError)
  const connections = useQuery({
    queryKey: connectionQueryKey,
    queryFn: getManagedModelAccessConnections,
    enabled: planEligible,
  })
  const bindings = useQuery({
    queryKey: bindingQueryKey,
    queryFn: () => getManagedModelAccessBindings(projectId),
    enabled: planEligible,
  })
  const routes = useQuery({
    queryKey: routeQueryKey,
    queryFn: () => getManagedModelRoutes(projectId),
    enabled: planEligible,
  })
  const codex = connections.data?.find(
    (connection) => connection.provider === 'openai',
  )
  const selectedConnection = connections.data?.find(
    (connection) =>
      connection.provider ===
        MODEL_ROUTE_PROVIDER_DEFAULTS[apiProvider].connectionProvider &&
      connection.status === 'connected',
  )
  const projectEnabled = hasProjectCodexAccess(bindings.data)
  const updateProjectAccess = useMutation({
    mutationFn: (enabled: boolean) =>
      Promise.all(
        projectCodexBindingUpdates(projectId, enabled).map((binding) =>
          putManagedModelAccessBinding(binding),
        ),
      ),
    onSuccess: async (_bindings, enabled) => {
      await queryClient.invalidateQueries({ queryKey: bindingQueryKey })
      notifySuccess(
        enabled
          ? 'Codex enabled for this project.'
          : 'Codex disabled for this project.',
      )
    },
    onError: (error, enabled) =>
      notifyError(
        enabled
          ? "Couldn't enable Codex for this project."
          : "Couldn't disable Codex for this project.",
        error,
      ),
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: connectionQueryKey }),
        queryClient.invalidateQueries({ queryKey: bindingQueryKey }),
      ])
      notifySuccess('Codex account disconnected.')
    },
    onError: (error) =>
      notifyError("Couldn't disconnect the Codex account.", error),
  })
  const configureApiRoute = useMutation({
    mutationFn: async () => {
      const connection =
        apiProvider === 'codex' || apiProvider === 'claude'
          ? selectedConnection
          : await connectManagedModelApiKey({
              provider: apiProvider,
              apiKey,
              ...(apiProvider === 'openai_compatible' ? { baseUrl } : {}),
            })
      if (!connection) {
        throw new Error(
          `Connect ${apiProvider === 'codex' ? 'Codex' : 'Claude'} first.`,
        )
      }
      return Promise.all(
        (['development', 'production'] as const).map((environment) =>
          putManagedModelRoute({
            projectId,
            environment,
            connectionId: connection.id,
            model: routeModel,
            fallback: routeFallback,
          }),
        ),
      )
    },
    onSuccess: async () => {
      setApiKey('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: connectionQueryKey }),
        queryClient.invalidateQueries({ queryKey: routeQueryKey }),
      ])
      notifySuccess('Model connection and project route configured.')
    },
    onError: (error) =>
      notifyError("Couldn't configure the model route.", error),
  })
  if (
    billingLoading ||
    (planEligible &&
      (connections.isLoading || bindings.isLoading || routes.isLoading))
  ) {
    return (
      <Panel>
        <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading BYOK status…
        </PanelContent>
      </Panel>
    )
  }

  if (
    billingError ||
    (planEligible &&
      (connections.isError || bindings.isError || routes.isError))
  ) {
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
                void billing.refetch()
                if (billing.data?.billingProvider === 'autumn') {
                  void autumnBilling.refetch()
                }
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

  if (!planEligible) {
    return (
      <Panel>
        <EmptyState
          icon={LockKeyhole}
          title="BYOK is available on Pro"
          description="Upgrade to Pro to connect a Codex account and enable it for this project's development and production environments."
          action={
            <Button asChild>
              <Link to="/billing">Upgrade to Pro</Link>
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
            <PanelTitle>Project model route</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Route every new session through an organization connection. This
              overrides useModel() and also works when agent code selects no
              model.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-4">
          {routes.data?.length ? (
            <div className="space-y-2">
              {routes.data.map((route) => {
                const connection = connections.data?.find(
                  (candidate) => candidate.id === route.connectionId,
                )
                return (
                  <div
                    key={route.id}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <StatusBadge status="running" label={route.environment} />
                    <span>{route.model}</span>
                    <span className="text-muted-foreground">
                      via{' '}
                      {connection
                        ? modelConnectionLabel(connection)
                        : route.connectionId}{' '}
                      · {route.fallback} · r{route.revision}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No project override. Agent code and the platform default determine
              the model.
            </p>
          )}
          {canManageConnection ? (
            <div className="grid gap-3 border-t pt-4 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="font-medium">Provider</span>
                <select
                  className="border-input bg-background h-9 w-full rounded-md border px-3"
                  value={apiProvider}
                  onChange={(event) => {
                    setApiProvider(
                      event.target.value as ModelRouteProviderChoice,
                    )
                    setRouteModel(
                      MODEL_ROUTE_PROVIDER_DEFAULTS[
                        event.target.value as ModelRouteProviderChoice
                      ].model,
                    )
                  }}
                >
                  <option value="codex">Codex account</option>
                  <option value="claude">Claude account</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai_compatible">
                    Custom OpenAI-compatible API
                  </option>
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Provider model ID</span>
                <input
                  className="border-input bg-background h-9 w-full rounded-md border px-3"
                  value={routeModel}
                  onChange={(event) => setRouteModel(event.target.value)}
                />
              </label>
              {apiProvider === 'openai_compatible' ? (
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Base URL</span>
                  <input
                    className="border-input bg-background h-9 w-full rounded-md border px-3"
                    type="url"
                    value={baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </label>
              ) : null}
              {apiProvider === 'openrouter' ||
              apiProvider === 'openai_compatible' ? (
                <label className="space-y-1 text-sm">
                  <span className="font-medium">API key</span>
                  <input
                    className="border-input bg-background h-9 w-full rounded-md border px-3"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>
              ) : (
                <div className="text-muted-foreground flex items-end text-sm">
                  {selectedConnection
                    ? `Using ${modelConnectionLabel(selectedConnection)}.`
                    : `Connect a ${apiProvider === 'codex' ? 'Codex' : 'Claude'} account before saving this route.`}
                </div>
              )}
              <label className="space-y-1 text-sm">
                <span className="font-medium">If unavailable</span>
                <select
                  className="border-input bg-background h-9 w-full rounded-md border px-3"
                  value={routeFallback}
                  onChange={(event) =>
                    setRouteFallback(event.target.value as 'fail' | 'managed')
                  }
                >
                  <option value="fail">Fail closed</option>
                  <option value="managed">Use Managed</option>
                </select>
              </label>
              <div className="flex items-end">
                <Button
                  disabled={
                    !routeModel ||
                    (apiProvider === 'openai_compatible' && !baseUrl) ||
                    ((apiProvider === 'openrouter' ||
                      apiProvider === 'openai_compatible') &&
                      !apiKey) ||
                    ((apiProvider === 'codex' || apiProvider === 'claude') &&
                      !selectedConnection) ||
                    configureApiRoute.isPending
                  }
                  onClick={() => configureApiRoute.mutate()}
                >
                  {configureApiRoute.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Link2 />
                  )}
                  Save connection and route
                </Button>
              </div>
            </div>
          ) : null}
        </PanelContent>
      </Panel>
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>BYOK</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Connect one Codex account to your organization, then enable it for
              the projects that should use it. Project enablement always covers
              both development and production. Managed usage-based inference
              remains the fallback. Runtime compute is still charged.
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
                ? `Connected to your organization${codex.checkedAt ? ` · checked ${new Date(codex.checkedAt).toLocaleString()}` : ''}`
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
                <div className="mt-3 space-y-3">
                  <p className="text-muted-foreground text-sm">
                    The organization account is connected, but this project will
                    use Managed inference until it is enabled.
                  </p>
                  {canManageConnection && codex.status === 'connected' ? (
                    <Button
                      variant="outline"
                      disabled={updateProjectAccess.isPending}
                      onClick={() => updateProjectAccess.mutate(true)}
                    >
                      {updateProjectAccess.isPending ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Link2 />
                      )}
                      Enable for this project
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {canManageConnection && projectEnabled ? (
                <div className="mt-3 space-y-3">
                  <p className="text-muted-foreground text-sm">
                    Disable Codex here to return this project to Managed
                    inference without disconnecting the organization account.
                  </p>
                  <Button
                    variant="outline"
                    disabled={updateProjectAccess.isPending}
                    onClick={() => updateProjectAccess.mutate(false)}
                  >
                    {updateProjectAccess.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Link2Off />
                    )}
                    Disable for this project
                  </Button>
                </div>
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
            <PanelTitle>Code-selected model fallback</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              These selections apply only when this project has no matching
              project or agent route.
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
            <PanelTitle>
              {codex
                ? 'Replace the organization account with the CLI'
                : 'Connect an organization account with the CLI'}
            </PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              The Codex command opens OAuth, links or replaces the organization
              account, and enables it for this project. If the account is
              already connected, use the button above to enable this project
              without repeating OAuth.
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
