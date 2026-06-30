import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getSlackConnection,
  startSlackConnect,
  completeSlackConnect,
  disconnectSlack,
} from '@/api/client'
import type { SlackManifestResponse } from '@/api/schemas'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, Input } from '@/components/form'
import { StatusBadge } from '@/components/status-badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { cn } from '@/lib/utils'

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
          <li key={label} className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                done || active
                  ? 'bg-foreground text-background'
                  : 'bg-secondary text-muted-foreground',
              )}
            >
              {done ? <Check className="size-3" /> : i + 1}
            </span>
            <span
              className={cn(
                'truncate text-xs',
                active
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground',
              )}
            >
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

export function SlackConnect({
  agentId,
  agentName,
  autoOpen = false,
}: {
  agentId: string
  agentName: string
  autoOpen?: boolean
}) {
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['slack', agentId] })

  const {
    data: conn,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['slack', agentId],
    queryFn: () => getSlackConnection(agentId),
  })

  // Wizard state.
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('create')
  const [manifest, setManifest] = useState<SlackManifestResponse | null>(null)
  const [appId, setAppId] = useState('')
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmReconnect, setConfirmReconnect] = useState(false)
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
      void invalidate() // the row is now pending
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
      void invalidate()
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
      void invalidate()
      setConfirmDisconnect(false)
    },
    onError: (e) => notifyError("Couldn't disconnect Slack.", e),
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
      <PanelHeader>
        <PanelTitle>Slack</PanelTitle>
        {conn ? <StatusBadge status={status ?? 'pending'} /> : null}
      </PanelHeader>
      <PanelContent>
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Checking Slack…</p>
        ) : isError ? (
          <p className="text-muted-foreground text-sm">
            Slack status unavailable.
          </p>
        ) : isActive ? (
          <div className="space-y-3">
            <p className="text-sm">
              <span className="text-foreground font-medium">
                @{conn?.handle}
              </span>{' '}
              is connected{workspace ? ` to ${workspace}` : ''}.
            </p>
            <p className="text-muted-foreground text-sm">
              Invite the bot to a channel, then <strong>@-mention</strong> it to
              start or steer a session.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmReconnect(true)}
              >
                Reconnect
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ) : isErrorStatus ? (
          <div className="space-y-3">
            <p className="text-status-error text-sm">
              Slack reported a connection error (the token may have been
              revoked). Reconnect to fix it.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => beginConnect()}>
                Reconnect
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              Give this agent its own Slack handle. Members @-mention it to
              start and steer sessions from a channel.
            </p>
            <Button size="sm" onClick={() => beginConnect()}>
              {isPending ? 'Continue Slack setup' : 'Connect Slack'}
            </Button>
          </div>
        )}
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
              {step === 'done' ? 'Slack connected' : 'Connect Slack'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Connect this agent’s own Slack app so members can @-mention it.
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
        open={confirmReconnect}
        onOpenChange={setConfirmReconnect}
        title="Reconnect Slack?"
        description="This replaces the current Slack app. The agent stops responding in Slack until you finish setting up the new one."
        confirmLabel="Reconnect"
        onConfirm={() => {
          setConfirmReconnect(false)
          beginConnect(true)
        }}
      />
    </Panel>
  )
}
