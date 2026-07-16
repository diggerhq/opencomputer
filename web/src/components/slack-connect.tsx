import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { Check, Copy, ExternalLink, X } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  authorizeManagedSlack,
  disconnectManagedSlack,
  getAgent,
  getManagedSlackConnection,
  getSlackConnection,
  startSlackConnect,
  completeSlackConnect,
  disconnectSlack,
} from '@/api/client'
import type { SlackManifestResponse } from '@/api/schemas'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, Input } from '@/components/form'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { cn } from '@/lib/utils'
import { managedSlackNotice } from '@/lib/managed-slack-notice'

// An agent connects its OWN Slack app (BYO, 1:1:1). Connect is a two-step,
// manifest-route wizard (oc-bg-agents/.agents/design/008-slack-presence.md §2):
// START returns a manifest the user pastes into Slack's "From a manifest"
// flow; COMPLETE takes the three values Slack then hands back. No OAuth, no
// secrets in responses.
type Step = 'create' | 'details' | 'install' | 'done'

const WIZARD_STEPS = ['Create app', 'Details', 'Install', 'Done']

// Horizontal progress indicator — shows which step we're on; detail for each
// step is only shown when it's reached (in the body below).
function WizardSteps({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2 pt-2">
      {WIZARD_STEPS.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <li
            key={label}
            className="flex min-w-0 items-center gap-2"
            aria-current={active ? 'step' : undefined}
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                done || active
                  ? 'bg-foreground text-background'
                  : 'bg-secondary text-muted-foreground',
              )}
            >
              {done ? <Check className="size-3" aria-hidden /> : i + 1}
            </span>
            <span
              className={cn(
                'truncate text-xs',
                active
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground',
              )}
            >
              {done ? <span className="sr-only">Completed: </span> : null}
              {label}
            </span>
            {i < WIZARD_STEPS.length - 1 ? (
              <span className="bg-border h-px w-4 shrink-0" />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

// Compact one-line progress for the card view (closed wizard): "Step N of 4 · label".
function CompactSteps({ current }: { current: number }) {
  const n = Math.min(current + 1, WIZARD_STEPS.length)
  return (
    <p className="text-muted-foreground text-xs">
      Step {n} of {WIZARD_STEPS.length} · {WIZARD_STEPS[current] ?? 'Done'}
    </p>
  )
}

export function SlackConnect({
  agentId,
  agentName,
  autoOpen = false,
  canOpenSlack = true,
}: {
  agentId: string
  agentName: string
  autoOpen?: boolean
  canOpenSlack?: boolean
}) {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const invalidateByo = () =>
    queryClient.invalidateQueries({ queryKey: ['slack', 'byo', agentId] })
  const invalidateManaged = () =>
    queryClient.invalidateQueries({ queryKey: ['slack', 'managed', agentId] })

  const {
    data: conn,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['slack', 'byo', agentId],
    queryFn: () => getSlackConnection(agentId),
  })
  const managedQuery = useQuery({
    queryKey: ['slack', 'managed', agentId],
    queryFn: () => getManagedSlackConnection(agentId),
  })

  // Wizard state.
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('create')
  const [manifest, setManifest] = useState<SlackManifestResponse | null>(null)
  const [appId, setAppId] = useState('')
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmManagedDisconnect, setConfirmManagedDisconnect] =
    useState(false)
  const [copied, markCopied] = useTransientFlag(1500)

  const resetWizard = () => {
    setStep('create')
    setManifest(null)
    setAppId('')
    setBotToken('')
    setSigningSecret('')
  }

  const startMutation = useMutation({
    mutationFn: (reconnect: boolean) => startSlackConnect(agentId, reconnect),
    onSuccess: (m) => {
      setManifest(m)
      setStep('create')
      void invalidateByo() // the row is now pending
    },
    onError: (e) => notifyError("Couldn't start the Slack connection.", e),
  })

  const completeMutation = useMutation({
    mutationFn: () =>
      completeSlackConnect(agentId, {
        app_id: appId.trim(),
        bot_token: botToken.trim(),
        signing_secret: signingSecret.trim(),
      }),
    onSuccess: () => {
      void invalidateByo()
      setStep('done')
      setAppId('')
      setBotToken('')
      setSigningSecret('') // don't keep secrets in state past a successful connect
    },
    onError: (e) =>
      notifyError('Slack rejected those values. Double-check them.', e),
  })

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectSlack(agentId),
    onSuccess: () => {
      void invalidateByo()
      setConfirmDisconnect(false)
    },
    onError: (e) => notifyError("Couldn't disconnect Slack.", e),
  })

  const authorizeManagedMutation = useMutation({
    mutationFn: () => authorizeManagedSlack(agentId),
    onSuccess: (result) => {
      if ('authorize_url' in result) {
        window.location.assign(result.authorize_url)
        return
      }
      void invalidateManaged()
    },
    onError: (error) =>
      notifyError("Couldn't start the Slack connection.", error),
  })

  const disconnectManagedMutation = useMutation({
    mutationFn: () => disconnectManagedSlack(agentId),
    onSuccess: () => {
      void invalidateManaged()
      setConfirmManagedDisconnect(false)
    },
    onError: (error) =>
      notifyError("Couldn't disconnect OpenComputer Slack.", error),
  })

  const beginConnect = (reconnect = false) => {
    resetWizard()
    setOpen(true)
    startMutation.mutate(reconnect)
  }

  const copyManifest = () => {
    if (!manifest) return
    void navigator.clipboard
      .writeText(JSON.stringify(manifest.manifest, null, 2))
      .then(
        () => markCopied(),
        (e: unknown) => notifyError("Couldn't copy the manifest.", e),
      )
  }

  const status = conn?.status
  const isActive = status === 'active'
  const isPending = status === 'pending'
  const isErrorStatus = status === 'error'
  const workspace = conn?.account_login || conn?.team_id || null
  const managed = managedQuery.data
  const managedActive = managed?.status === 'active'
  const managedNeedsReconnect =
    managed?.status === 'error' || managed?.status === 'revoked'
  const managedDisconnected = managed?.status === 'disconnected'
  const managedWorkspace = managed?.workspace?.name || managed?.workspace?.id
  const oauthResult = searchParams.get('slack')
  const connectedAgentId = searchParams.get('connected_agent')
  const sameOwnerConnectedAgentId =
    oauthResult === 'workspace_already_connected' &&
    connectedAgentId &&
    /^agt_[0-9a-f]{24}$/.test(connectedAgentId)
      ? connectedAgentId
      : null
  const connectedAgentQuery = useQuery({
    queryKey: ['agent', sameOwnerConnectedAgentId],
    queryFn: () => getAgent(sameOwnerConnectedAgentId!),
    enabled: !!sameOwnerConnectedAgentId,
  })
  const connectedAgentName = connectedAgentQuery.data?.name ?? null
  const notice =
    sameOwnerConnectedAgentId && connectedAgentQuery.isLoading
      ? null
      : managedSlackNotice(
          oauthResult,
          managedWorkspace,
          agentName,
          connectedAgentName,
        )
  const connectedAgentHref =
    connectedAgentQuery.data && sameOwnerConnectedAgentId
      ? `/agents/${encodeURIComponent(sameOwnerConnectedAgentId)}`
      : null
  const dismissNotice = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('slack')
    next.delete('connected_agent')
    setSearchParams(next, { replace: true })
  }
  const stepIndex =
    step === 'create' ? 0 : step === 'details' ? 1 : step === 'install' ? 2 : 3

  // Arrived via a setup CTA (?connect=slack) → open the wizard once, unless
  // already connected. Latched so a re-render / param-clear doesn't re-trigger.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (autoOpen && !autoOpenedRef.current && !isLoading && !isActive) {
      autoOpenedRef.current = true
      beginConnect()
    }
    // beginConnect is a stable-enough closure; the ref guards single-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, isLoading, isActive])

  return (
    <Panel className="overflow-hidden">
      <PanelContent className="space-y-4">
        <div className="text-muted-foreground text-xs font-medium">Slack</div>

        {notice ? (
          <Alert variant={notice.destructive ? 'destructive' : 'default'}>
            <AlertTitle>{notice.title}</AlertTitle>
            {notice.description || connectedAgentHref ? (
              <AlertDescription>
                {notice.description}{' '}
                {connectedAgentHref ? (
                  <Link to={connectedAgentHref}>Open connected agent</Link>
                ) : null}
              </AlertDescription>
            ) : null}
            <AlertAction>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss Slack notice"
                onClick={dismissNotice}
              >
                <X aria-hidden />
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        <section className="space-y-3" aria-labelledby="managed-slack-title">
          <div className="space-y-1">
            <h3 id="managed-slack-title" className="text-sm font-medium">
              OpenComputer app
            </h3>
            {!managedActive && !managedDisconnected ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                Connect the shared app to try this agent in Slack.
              </p>
            ) : null}
          </div>

          {managedQuery.isLoading ? (
            <div className="space-y-2" aria-label="Checking Slack connection">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-7 w-32" />
            </div>
          ) : managedQuery.isError ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                Managed Slack status is unavailable.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void managedQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : managedActive ? (
            <div className="space-y-2">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span
                  className="bg-status-running size-2 shrink-0 rounded-full"
                  aria-hidden
                />
                <span className="sr-only">Connected.</span>
                <span className="truncate">
                  OpenComputer
                  {managedWorkspace ? (
                    <span className="text-muted-foreground">
                      {' '}
                      · {managedWorkspace}
                    </span>
                  ) : null}
                </span>
              </div>
              {!canOpenSlack ? (
                <p className="text-muted-foreground text-xs">
                  Connected. Deploy this agent before opening Slack.
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {canOpenSlack && managed?.open_url ? (
                  <Button asChild size="sm">
                    <a href={managed.open_url} target="_blank" rel="noreferrer">
                      Open Slack
                      <ExternalLink aria-hidden />
                    </a>
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setConfirmManagedDisconnect(true)}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ) : managedNeedsReconnect ? (
            <div className="space-y-2">
              <p className="text-status-error text-sm">
                The OpenComputer app needs authorization.
              </p>
              <Button
                size="sm"
                onClick={() => authorizeManagedMutation.mutate()}
                disabled={authorizeManagedMutation.isPending}
              >
                {authorizeManagedMutation.isPending
                  ? 'Connecting…'
                  : 'Reconnect Slack'}
              </Button>
            </div>
          ) : managedDisconnected ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs leading-relaxed">
                Disconnected. This agent no longer receives messages from the
                OpenComputer app.
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Anyone in this Slack workspace who can message the app can use
                this agent after you reconnect it.
              </p>
              <Button
                size="sm"
                onClick={() => authorizeManagedMutation.mutate()}
                disabled={authorizeManagedMutation.isPending}
              >
                {authorizeManagedMutation.isPending
                  ? 'Connecting…'
                  : 'Connect Slack again'}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs leading-relaxed">
                Anyone in this Slack workspace who can message the app can use
                this agent.
              </p>
              <Button
                size="sm"
                onClick={() => authorizeManagedMutation.mutate()}
                disabled={authorizeManagedMutation.isPending}
              >
                {authorizeManagedMutation.isPending
                  ? 'Connecting…'
                  : 'Connect OpenComputer Slack'}
              </Button>
            </div>
          )}
        </section>

        <section
          className="space-y-2 border-t pt-3"
          aria-labelledby="byo-slack-title"
        >
          <h3 id="byo-slack-title" className="text-sm font-medium">
            Your app
          </h3>
          {managedActive && isActive ? (
            <p className="text-muted-foreground text-xs leading-relaxed">
              Your app is active. Disconnect the OpenComputer app when the
              handoff is complete.
            </p>
          ) : null}
          {isLoading ? (
            <Skeleton
              className="h-7 w-28"
              aria-label="Checking your Slack app"
            />
          ) : isError ? (
            <p className="text-muted-foreground text-xs">
              Your Slack app status is unavailable.
            </p>
          ) : isActive ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm">
                <span className="text-status-running" aria-hidden>
                  ●
                </span>{' '}
                <span className="sr-only">Connected.</span>
                <span className="text-foreground font-medium">
                  @{conn?.handle}
                </span>
                {workspace ? (
                  <span className="text-muted-foreground"> · {workspace}</span>
                ) : null}
              </span>
              <div className="flex items-center gap-1">
                {canOpenSlack && conn?.open_url ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={conn.open_url} target="_blank" rel="noreferrer">
                      Open Slack
                      <ExternalLink aria-hidden />
                    </a>
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setConfirmDisconnect(true)}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ) : isErrorStatus ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-status-error text-sm">
                Connection error
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => beginConnect()}
              >
                Reconnect your app
              </Button>
            </div>
          ) : isPending ? (
            <div className="space-y-2">
              <CompactSteps current={stepIndex} />
              <Button
                variant="outline"
                size="sm"
                onClick={() => beginConnect()}
              >
                Continue app setup
              </Button>
            </div>
          ) : (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={() => beginConnect()}
            >
              Use your own Slack app
            </Button>
          )}
        </section>
      </PanelContent>

      {/* Connect wizard */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) resetWizard()
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {step === 'done'
                ? 'Your Slack app is connected'
                : 'Connect your own Slack app'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Connect a Slack app you operate so members can message this agent.
            </DialogDescription>
            <WizardSteps current={stepIndex} />
          </DialogHeader>

          {step === 'create' ? (
            <div className="min-w-0 space-y-4">
              {startMutation.isPending || !manifest ? (
                <p className="text-muted-foreground text-sm">
                  Preparing the manifest…
                </p>
              ) : (
                <>
                  {/* Linear flow: read → Copy → Open Slack. The action row sits
                      right under the explainer (Copy before the link), with the
                      manifest below as reference. */}
                  <p className="text-muted-foreground text-sm">
                    Copy this manifest, then create the app from it in Slack.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="outline" size="sm" onClick={copyManifest}>
                      {copied ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      {/* Reserve the wider label's width (stacked grid) so the
                          button — and the link beside it — don't shift when it
                          flips to "Copied". */}
                      <span className="grid">
                        <span className="invisible col-start-1 row-start-1">
                          Copy manifest
                        </span>
                        <span className="col-start-1 row-start-1 text-left">
                          {copied ? 'Copied' : 'Copy manifest'}
                        </span>
                      </span>
                    </Button>
                    <a
                      href={manifest.create_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
                    >
                      Open Slack apps
                      <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                  <pre className="bg-panel-2 max-h-60 min-w-0 overflow-y-auto rounded-md border p-3 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
                    {JSON.stringify(manifest.manifest, null, 2)}
                  </pre>
                </>
              )}
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOpen(false)
                    resetWizard()
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => setStep('details')}
                  disabled={!manifest || startMutation.isPending}
                >
                  Next: app details
                </Button>
              </DialogFooter>
            </div>
          ) : step === 'details' ? (
            <form
              className="min-w-0 space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (appId.trim() && signingSecret.trim()) setStep('install')
              }}
            >
              <p className="text-muted-foreground text-sm">
                From Basic Information → App Credentials, copy these two.
              </p>
              <Field
                label="App ID"
                htmlFor="slack-app-id"
                description="Top of the App Credentials section."
              >
                <Input
                  id="slack-app-id"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="A01234ABCDE"
                />
              </Field>
              <Field
                label="Signing Secret"
                htmlFor="slack-signing-secret"
                description="Same section, under Client Secret."
              >
                <Input
                  id="slack-signing-secret"
                  type="password"
                  value={signingSecret}
                  onChange={(e) => setSigningSecret(e.target.value)}
                  placeholder="••••••••"
                />
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep('create')}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={!appId.trim() || !signingSecret.trim()}
                >
                  Next: install
                </Button>
              </DialogFooter>
            </form>
          ) : step === 'install' ? (
            <form
              className="min-w-0 space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                completeMutation.mutate()
              }}
            >
              <p className="text-muted-foreground text-sm">
                In the sidebar, open Install App → Install to Workspace to get
                the token.
              </p>
              <Field
                label="Bot User OAuth Token"
                htmlFor="slack-bot-token"
                description="Install App → Bot User OAuth Token (starts with xoxb-)."
              >
                <Input
                  id="slack-bot-token"
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="xoxb-…"
                />
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep('details')}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={
                    completeMutation.isPending ||
                    !appId.trim() ||
                    !signingSecret.trim() ||
                    !botToken.trim()
                  }
                >
                  {completeMutation.isPending ? 'Connecting…' : 'Connect'}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="min-w-0 space-y-4">
              <div className="space-y-2 text-sm">
                <p>
                  <span className="text-foreground font-medium">
                    @{conn?.handle ?? agentName}
                  </span>{' '}
                  is connected{workspace ? ` to ${workspace}` : ''}.
                </p>
                <p className="text-muted-foreground">
                  Invite the bot to a channel, then @-mention it to start a
                  session.
                </p>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setOpen(false)
                    resetWizard()
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Slack?"
        description="The agent’s Slack app stops working until reconnected. Its bot token and signing secret are purged."
        confirmLabel="Disconnect"
        destructive
        pending={disconnectMutation.isPending}
        onConfirm={() => disconnectMutation.mutate()}
      />

      <ConfirmDialog
        open={confirmManagedDisconnect}
        onOpenChange={setConfirmManagedDisconnect}
        title="Disconnect OpenComputer Slack?"
        description="This agent will stop receiving messages from the OpenComputer app. The app stays installed in the workspace."
        confirmLabel="Disconnect"
        destructive
        pending={disconnectManagedMutation.isPending}
        onConfirm={() => disconnectManagedMutation.mutate()}
      />
    </Panel>
  )
}
