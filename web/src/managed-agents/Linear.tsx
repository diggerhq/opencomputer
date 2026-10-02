import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  Bot,
  Check,
  ExternalLink,
  Loader2,
  TriangleAlert,
  Unplug,
  X,
} from 'lucide-react'
import { ApiError } from '@/api/client'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyRow } from '@/components/copy-row'
import { EmptyState } from '@/components/empty-state'
import { Field, Input } from '@/components/form'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { ServiceLogo } from '@/components/service-logo'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  authorizeManagedLinearConnection,
  createManagedLinearConnection,
  disconnectManagedLinearConnection,
  displayManagedAgentName,
  getManagedProject,
  listManagedLinearConnections,
  setManagedLinearCredentials,
  type ManagedLinearConnection,
} from './api'
import {
  LINEAR_RETURN_COPY,
  checkLinearAppName,
  describeLinearRow,
  isLinearCredentialValue,
  linearAuthorizationHref,
  linearCreateAppHref,
  linearLastEventAt,
  linearNeedsPolling,
  linearReturnFromSearch,
  linearRowsForProject,
  withoutLinearReturn,
  type LinearEnvironment,
  type LinearReturn,
  type LinearRow,
} from './linear-setup'

const connectionsQueryKey = (projectId: string) => [
  'managed-linear-connections',
  projectId,
]

/**
 * Linear's authorization page opens in this tab. The platform brings the
 * browser back to this project's Connections tab with the outcome in the
 * query; a page closed halfway leaves the connection waiting for
 * authorization, and "Authorize in Linear" is offered again.
 */
async function openLinearAuthorization(connectionId: string) {
  const { authorizeUrl } = await authorizeManagedLinearConnection(connectionId)
  window.location.assign(linearAuthorizationHref(authorizeUrl))
}

/**
 * Project → Connections → Linear. One row per environment: the Linear app
 * that is the environment's agent in Linear, its setup state and health.
 * Setup creates the app in Linear from a prefilled page, takes its
 * credentials, and has a workspace admin authorize it.
 */
export function ManagedProjectLinear({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  // The outcome Linear's authorization brought us back with. Read once, then
  // removed from the URL so a reload does not announce it again.
  const [returned, setReturned] = useState<LinearReturn | undefined>(() =>
    linearReturnFromSearch(searchParams.toString()),
  )
  useEffect(() => {
    if (!searchParams.has('linear')) return
    void queryClient.invalidateQueries({
      queryKey: ['managed-linear-connections'],
    })
    setSearchParams(
      new URLSearchParams(withoutLinearReturn(searchParams.toString())),
      { replace: true },
    )
  }, [queryClient, searchParams, setSearchParams])

  const project = useQuery({
    queryKey: ['managed-project', projectId],
    queryFn: () => getManagedProject(projectId),
  })
  const connections = useQuery({
    queryKey: connectionsQueryKey(projectId),
    queryFn: () => listManagedLinearConnections(projectId),
    refetchOnWindowFocus: true,
    // An authorized connection proves itself on its first Linear event.
    refetchInterval: (query) =>
      linearNeedsPolling(query.state.data) ? 5_000 : false,
  })
  const [dialog, setDialog] = useState<DialogTarget>()

  const agentNames = new Map(
    (project.data?.project.agents ?? []).map((agent) => [
      agent.id,
      displayManagedAgentName(agent),
    ]),
  )
  const rows = project.data
    ? linearRowsForProject(project.data.project, connections.data ?? [])
    : []

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle className="flex items-center gap-2">
            <ServiceLogo service="linear" className="size-4" />
            Linear
          </PanelTitle>
          <PanelDescription className="mt-1 max-w-2xl">
            A Linear app per environment that is your agent in Linear. People
            delegate issues to it and mention it in comments; each delegation
            starts a session.
          </PanelDescription>
        </div>
      </PanelHeader>
      {returned ? (
        <ReturnBanner
          returned={returned}
          onDismiss={() => setReturned(undefined)}
        />
      ) : null}
      {project.isLoading || connections.isLoading ? (
        <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading Linear status…
        </PanelContent>
      ) : project.isError || connections.isError ? (
        <EmptyState
          icon={Bot}
          title={
            connections.error instanceof ApiError &&
            connections.error.type === 'linear_connector_unavailable'
              ? 'Linear connections are not available right now'
              : 'Linear status is temporarily unavailable'
          }
          description="Try loading the project again."
          action={
            <Button
              variant="outline"
              onClick={() => {
                void project.refetch()
                void connections.refetch()
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        rows.map((row) => (
          <LinearRowItem
            key={`${projectId}:${row.environment}`}
            projectId={projectId}
            row={row}
            agentName={
              row.agentId
                ? (agentNames.get(row.agentId) ?? row.agentId)
                : undefined
            }
            highlighted={
              returned !== undefined &&
              returned.connectionId !== undefined &&
              returned.connectionId === row.connection?.id
            }
            onOpenSetup={(step) =>
              setDialog({ environment: row.environment, step })
            }
          />
        ))
      )}
      {dialog
        ? (() => {
            const row = rows.find(
              (candidate) => candidate.environment === dialog.environment,
            )
            if (!row?.agentId) return null
            return (
              <LinearSetupDialog
                projectId={projectId}
                environment={row.environment}
                agentId={row.agentId}
                agentName={agentNames.get(row.agentId) ?? row.agentId}
                existing={row.connection}
                initialStep={dialog.step}
                onClose={() => setDialog(undefined)}
              />
            )
          })()
        : null}
    </Panel>
  )
}

type SetupStep = 'name' | 'app' | 'credentials' | 'authorize'
type DialogTarget = { environment: LinearEnvironment; step: SetupStep }

function ReturnBanner({
  returned,
  onDismiss,
}: {
  returned: LinearReturn
  onDismiss: () => void
}) {
  const copy = LINEAR_RETURN_COPY[returned.result]
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 border-b px-5 py-4',
        copy.tone === 'success'
          ? 'bg-status-running-bg/40'
          : 'bg-status-error-bg/40',
      )}
    >
      {copy.tone === 'success' ? (
        <Check className="text-status-running mt-0.5 size-5" aria-hidden />
      ) : (
        <TriangleAlert
          className="text-status-error mt-0.5 size-5"
          aria-hidden
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="text-muted-foreground text-sm">{copy.description}</p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  )
}

function LinearRowItem({
  projectId,
  row,
  agentName,
  highlighted,
  onOpenSetup,
}: {
  projectId: string
  row: LinearRow
  agentName?: string
  highlighted: boolean
  onOpenSetup: (step: SetupStep) => void
}) {
  const queryClient = useQueryClient()
  const connection = row.connection
  const view = describeLinearRow(row)
  const lastEventAt = linearLastEventAt(connection)
  // The confirmation names the connection it was opened for; it never
  // disconnects whatever is current when confirmed.
  const [disconnectTarget, setDisconnectTarget] =
    useState<ManagedLinearConnection>()

  // Set before the mutation is asked to run, so two clicks in one task
  // cannot both issue a state; `isPending` is only a render snapshot.
  const authorizing = useRef(false)
  const authorize = useMutation({
    mutationFn: (connectionId: string) => openLinearAuthorization(connectionId),
    onError: (error) => notifyError("Couldn't open Linear.", error),
    onSettled: () => {
      authorizing.current = false
    },
  })
  const startAuthorization = (connectionId: string) => {
    if (authorizing.current) return
    authorizing.current = true
    authorize.mutate(connectionId)
  }

  const disconnect = useMutation({
    mutationFn: (target: ManagedLinearConnection) =>
      disconnectManagedLinearConnection(target.id),
    onSuccess: (result, target) => {
      setDisconnectTarget(undefined)
      void queryClient.invalidateQueries({
        queryKey: connectionsQueryKey(projectId),
      })
      notifySuccess(
        `Linear disconnected from ${row.environment}.`,
        target.status === 'connected' && !result.revoked
          ? 'Linear did not confirm that the app’s access was revoked. Remove the app in Linear’s settings to be sure.'
          : undefined,
      )
    },
    onError: (error) => notifyError("Couldn't disconnect Linear.", error),
  })

  const Icon =
    view.tone === 'error'
      ? TriangleAlert
      : view.tone === 'success'
        ? Check
        : view.tone === 'waiting'
          ? Loader2
          : Bot

  return (
    <div
      className={cn(
        'space-y-3 border-t px-5 py-4 first:border-t-0',
        highlighted && view.tone === 'error' && 'bg-status-error-bg/20',
        highlighted && view.tone !== 'error' && 'bg-status-running-bg/20',
      )}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            'mt-0.5 size-5 shrink-0',
            view.tone === 'error'
              ? 'text-status-error'
              : view.tone === 'success'
                ? 'text-status-running'
                : 'text-muted-foreground',
            view.tone === 'waiting' && 'animate-spin',
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {row.environment}
            {agentName ? ` · ${agentName}` : ''}
          </p>
          <p className="mt-0.5 text-sm font-medium">
            {connection ? `${connection.name}: ${view.title}` : view.title}
          </p>
          <p className="text-muted-foreground text-sm">{view.description}</p>
          {lastEventAt ? (
            <p className="text-muted-foreground mt-1 text-xs">
              Last event {new Date(lastEventAt).toLocaleString()}
            </p>
          ) : null}
        </div>
      </div>
      {view.primary || connection ? (
        <div className="flex flex-wrap items-center gap-2 pl-8">
          {view.primary?.action === 'create' ? (
            <Button size="sm" onClick={() => onOpenSetup('name')}>
              {view.primary.label}
            </Button>
          ) : null}
          {view.primary?.action === 'continue' ? (
            <Button
              size="sm"
              onClick={() =>
                onOpenSetup(connection?.createAppUrl ? 'app' : 'name')
              }
            >
              {view.primary.label}
            </Button>
          ) : null}
          {view.primary?.action === 'authorize' && connection ? (
            <>
              <Button
                size="sm"
                disabled={authorize.isPending}
                onClick={() => startAuthorization(connection.id)}
              >
                {authorize.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                {authorize.isPending ? 'Opening Linear…' : view.primary.label}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenSetup('credentials')}
              >
                Replace credentials
              </Button>
            </>
          ) : null}
          {connection ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDisconnectTarget(connection)}
            >
              <Unplug /> Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(disconnectTarget)}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(undefined)
        }}
        title={`Disconnect ${disconnectTarget?.name ?? 'the Linear agent'}?`}
        description={`OpenComputer revokes the app’s access and stops accepting its webhooks in ${row.environment}. The app stays in your Linear workspace; delete it there if you no longer need it. Connecting again starts a new setup.`}
        confirmLabel="Disconnect"
        destructive
        pending={disconnect.isPending}
        onConfirm={() => {
          if (disconnectTarget && disconnectTarget.id === connection?.id) {
            disconnect.mutate(disconnectTarget)
          }
        }}
      />
    </div>
  )
}

/**
 * The setup, one step at a time: name → create the app in Linear → paste its
 * credentials → authorize. The connection lives on the platform from the
 * first step on, so closing the dialog at any point leaves a setup the row
 * can continue. The secrets are held in component state only while their
 * field is on screen, travel to the request through a ref (never as mutation
 * variables, so no cache holds them), and are cleared on every outcome.
 */
function LinearSetupDialog({
  projectId,
  environment,
  agentId,
  agentName,
  existing,
  initialStep,
  onClose,
}: {
  projectId: string
  environment: LinearEnvironment
  agentId: string
  agentName: string
  existing?: ManagedLinearConnection
  initialStep: SetupStep
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<SetupStep>(initialStep)
  const [connection, setConnection] = useState(existing)
  const [name, setName] = useState(existing?.name ?? agentName)
  const [submitError, setSubmitError] = useState<string>()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const credentialsRef = useRef<{
    clientId: string
    clientSecret: string
    signingSecret: string
  }>(undefined)
  const inFlight = useRef(false)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: connectionsQueryKey(projectId) })
  const clearSecrets = () => {
    setClientSecret('')
    setSigningSecret('')
    credentialsRef.current = undefined
  }
  const close = () => {
    clearSecrets()
    onClose()
  }

  const nameCheck = checkLinearAppName(name)
  const create = useMutation({
    gcTime: 0,
    mutationFn: (checkedName: string) =>
      createManagedLinearConnection({
        projectId,
        environment,
        agentId,
        name: checkedName,
      }),
    onSuccess: (result) => {
      setConnection({
        ...result.connection,
        webhookUrl: result.webhookUrl,
        createAppUrl: result.createAppUrl,
      })
      setStep('app')
      void invalidate()
    },
    onError: (error) => {
      void invalidate()
      if (
        error instanceof ApiError &&
        error.type === 'linear_already_connected'
      ) {
        notifyError('Linear is already connected.', error)
        close()
        return
      }
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'The Linear connection could not be created.',
      )
    },
    onSettled: () => {
      inFlight.current = false
    },
  })

  const saveCredentials = useMutation({
    gcTime: 0,
    mutationFn: async (connectionId: string) => {
      const credentials = credentialsRef.current
      credentialsRef.current = undefined
      if (!credentials) throw new Error('Paste the credentials again.')
      return setManagedLinearCredentials(connectionId, credentials)
    },
    onSuccess: (updated) => {
      setConnection((current) => ({
        ...updated,
        webhookUrl: updated.webhookUrl ?? current?.webhookUrl,
        createAppUrl: updated.createAppUrl ?? current?.createAppUrl,
      }))
      setStep('authorize')
      void invalidate()
    },
    onError: (error) => {
      void invalidate()
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'The credentials could not be saved.',
      )
    },
    onSettled: () => {
      inFlight.current = false
      clearSecrets()
    },
  })

  const authorize = useMutation({
    mutationFn: (connectionId: string) => openLinearAuthorization(connectionId),
    onError: (error) => {
      setSubmitError(
        error instanceof Error ? error.message : 'Linear could not be opened.',
      )
    },
    onSettled: () => {
      inFlight.current = false
    },
  })

  const pending =
    create.isPending || saveCredentials.isPending || authorize.isPending

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (inFlight.current) return
    setSubmitError(undefined)
    if (step === 'name') {
      if (!nameCheck.ok) return
      inFlight.current = true
      create.mutate(nameCheck.name)
      return
    }
    if (step === 'app') {
      setStep('credentials')
      return
    }
    if (!connection) return
    if (step === 'credentials') {
      const values = {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        signingSecret: signingSecret.trim(),
      }
      if (
        !isLinearCredentialValue(values.clientId) ||
        !isLinearCredentialValue(values.clientSecret) ||
        !isLinearCredentialValue(values.signingSecret)
      ) {
        setSubmitError(
          'Paste the client ID, client secret and webhook signing secret exactly as Linear shows them.',
        )
        return
      }
      inFlight.current = true
      credentialsRef.current = values
      saveCredentials.mutate(connection.id)
      return
    }
    inFlight.current = true
    authorize.mutate(connection.id)
  }

  const nameError = name.trim() && !nameCheck.ok ? nameCheck.message : undefined
  let createAppHref: string | undefined
  try {
    createAppHref = connection?.createAppUrl
      ? linearCreateAppHref(connection.createAppUrl)
      : undefined
  } catch {
    createAppHref = undefined
  }
  const appName = connection?.name ?? name

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) close()
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <form className="space-y-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create Linear agent</DialogTitle>
            <DialogDescription>
              {agentName} · {environment}. {STEP_LABELS[step]}
            </DialogDescription>
          </DialogHeader>

          {step === 'name' ? (
            <Field
              label="Name in Linear"
              htmlFor="managed-linear-name"
              error={nameError}
              description="The Linear app’s name is the agent’s name in Linear: people delegate issues to it and mention it by this name."
            >
              <Input
                id="managed-linear-name"
                value={name}
                maxLength={64}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          ) : null}

          {step === 'app' ? (
            <div className="space-y-3 text-sm">
              <p>
                Linear opens its new-app page with the name{' '}
                <span className="font-medium">{appName}</span>, the callback and
                the webhook URL already filled in. Create the app in the Linear
                workspace the agent will work in, and keep its name: that is the
                agent’s name in Linear.
              </p>
              {createAppHref ? (
                <Button asChild size="sm">
                  <a href={createAppHref} target="_blank" rel="noreferrer">
                    Open Linear to create the app <ExternalLink />
                  </a>
                </Button>
              ) : null}
              {connection?.webhookUrl ? (
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs">
                    If Linear asks for it, this is the webhook URL. It contains
                    a secret token, so do not share it.
                  </p>
                  <CopyRow value={connection.webhookUrl} maskable />
                </div>
              ) : null}
              <p className="text-muted-foreground text-xs">
                After you create the app, Linear shows its client ID, client
                secret and webhook signing secret. You paste them in the next
                step.
              </p>
            </div>
          ) : null}

          {step === 'credentials' ? (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm">
                Copy these from the app’s page in Linear. They are stored
                encrypted and never shown again.
              </p>
              <Field label="Client ID" htmlFor="managed-linear-client-id">
                <Input
                  id="managed-linear-client-id"
                  value={clientId}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </Field>
              <Field
                label="Client secret"
                htmlFor="managed-linear-client-secret"
              >
                <Input
                  id="managed-linear-client-secret"
                  type="password"
                  value={clientSecret}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </Field>
              <Field
                label="Webhook signing secret"
                htmlFor="managed-linear-signing-secret"
              >
                <Input
                  id="managed-linear-signing-secret"
                  type="password"
                  value={signingSecret}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setSigningSecret(event.target.value)}
                />
              </Field>
            </div>
          ) : null}

          {step === 'authorize' ? (
            <div className="space-y-2 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <Check className="text-status-running size-4" aria-hidden />
                Credentials saved
              </p>
              <p className="text-muted-foreground">
                Authorize {appName} in Linear to finish. A Linear workspace
                admin must approve the app. Linear then brings you back here.
              </p>
            </div>
          ) : null}

          {submitError ? (
            <p role="alert" className="text-status-error text-sm">
              {submitError}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={close}
            >
              {step === 'name' ? 'Cancel' : 'Finish later'}
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                (step === 'name' && !nameCheck.ok) ||
                (step === 'credentials' &&
                  (!clientId.trim() ||
                    !clientSecret.trim() ||
                    !signingSecret.trim()))
              }
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              {SUBMIT_LABELS[step](pending)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const STEP_LABELS: Record<SetupStep, string> = {
  name: 'Step 1 of 4: name the agent.',
  app: 'Step 2 of 4: create the app in Linear.',
  credentials: 'Step 3 of 4: paste the app’s credentials.',
  authorize: 'Step 4 of 4: authorize the app.',
}

const SUBMIT_LABELS: Record<SetupStep, (pending: boolean) => string> = {
  name: (pending) => (pending ? 'Creating…' : 'Create'),
  app: () => 'I created the app',
  credentials: (pending) => (pending ? 'Saving…' : 'Save credentials'),
  authorize: (pending) => (pending ? 'Opening Linear…' : 'Authorize in Linear'),
}
