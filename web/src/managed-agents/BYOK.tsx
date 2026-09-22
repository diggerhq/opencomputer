import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit, Link2, LockKeyhole, Loader2, Trash2 } from 'lucide-react'
import { getAutumnBilling, getBilling } from '@/api/client'
import { ConfirmDialog } from '@/components/confirm-dialog'
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
  deleteManagedModelRoute,
  getManagedModelAccessConnections,
  getManagedModelRoutes,
  putManagedModelRoute,
} from './api'
import {
  DEFAULT_MODEL_ROUTE_PROVIDER,
  hasBYOKPlanAccess,
  MODEL_ROUTE_MODEL_SUGGESTIONS,
  MODEL_ROUTE_PROVIDER_DEFAULTS,
  modelConnectionLabel,
  SUBSCRIPTION_ROUTE_AVAILABILITY,
  type ModelRouteProviderChoice,
} from './byok-config'

export function ManagedProjectBYOK({ projectId }: { projectId: string }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [confirmRemoveRoute, setConfirmRemoveRoute] = useState(false)
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
  const connectionQueryKey = ['managed-model-access-connections']
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
  const routes = useQuery({
    queryKey: routeQueryKey,
    queryFn: () => getManagedModelRoutes(projectId),
    enabled: planEligible,
  })
  const removeRoute = useMutation({
    mutationFn: () =>
      Promise.all(
        (['development', 'production'] as const).map((environment) =>
          deleteManagedModelRoute({ projectId, environment }),
        ),
      ),
    onSuccess: async () => {
      setConfirmRemoveRoute(false)
      await queryClient.invalidateQueries({ queryKey: routeQueryKey })
      notifySuccess('Project model route removed.')
    },
    onError: (error) =>
      notifyError("Couldn't remove the project model route.", error),
  })
  const configureApiRoute = useMutation({
    mutationFn: async () => {
      const connection = await connectManagedModelApiKey({
        provider: apiProvider,
        apiKey,
        ...(apiProvider === 'openai_compatible' ? { baseUrl } : {}),
      })
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
    (planEligible && (connections.isLoading || routes.isLoading))
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
    (planEligible && (connections.isError || routes.isError))
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
          description="Upgrade to Pro to connect your model provider and configure a project model route."
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
            <PanelTitle>Bring your own model</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Send every new session through your OpenRouter or
              OpenAI-compatible API key. This project route overrides useModel()
              and also works when agent code selects no model.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-4">
          {routes.data?.length ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
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
              {canManageConnection ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={removeRoute.isPending}
                  onClick={() => setConfirmRemoveRoute(true)}
                >
                  {removeRoute.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  Remove route
                </Button>
              ) : null}
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
                    setApiKey('')
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
                  <option value="openrouter">OpenRouter API key</option>
                  <option value="openai_compatible">
                    Custom OpenAI-compatible API
                  </option>
                  {SUBSCRIPTION_ROUTE_AVAILABILITY.map((provider) => (
                    <option
                      key={provider.id}
                      value={provider.id}
                      disabled={provider.disabled}
                    >
                      {provider.label}
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground block text-xs">
                  Codex and Claude subscription connections are coming soon.
                </span>
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Provider model ID</span>
                <input
                  className="border-input bg-background h-9 w-full rounded-md border px-3"
                  value={routeModel}
                  list={`model-route-${apiProvider}-models`}
                  autoComplete="off"
                  onChange={(event) => setRouteModel(event.target.value)}
                />
                <datalist id={`model-route-${apiProvider}-models`}>
                  {MODEL_ROUTE_MODEL_SUGGESTIONS[apiProvider].map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
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
                    !apiKey ||
                    configureApiRoute.isPending
                  }
                  onClick={() => configureApiRoute.mutate()}
                >
                  {configureApiRoute.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Link2 />
                  )}
                  Connect and save route
                </Button>
              </div>
            </div>
          ) : null}
        </PanelContent>
      </Panel>
      <ConfirmDialog
        open={confirmRemoveRoute}
        onOpenChange={setConfirmRemoveRoute}
        title="Remove this project route?"
        description="New sessions will use the model selected by agent code or the platform default. The provider connection remains available to other projects."
        confirmLabel="Remove route"
        onConfirm={() => removeRoute.mutate()}
      />
    </div>
  )
}
