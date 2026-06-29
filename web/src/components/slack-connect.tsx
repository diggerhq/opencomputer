import { useState } from 'react'
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
import { CopyRow } from '@/components/copy-row'
import { StatusBadge } from '@/components/status-badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { cn } from '@/lib/utils'

// An agent connects its OWN Slack app (BYO, 1:1:1). Connect is a two-step,
// manifest-route wizard (oc-bg-agents/.agents/design/008-slack-presence.md §2):
// START returns a manifest the user pastes into Slack's "From a manifest"
// flow; COMPLETE takes the three values Slack then hands back. No OAuth, no
// secrets in responses.
type Step = 'create' | 'paste' | 'done'

const WIZARD_STEPS = ['Create app', 'Connect', 'Done']

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
}: {
  agentId: string
  agentName: string
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
  const [copied, markCopied] = useTransientFlag(1500)

  const resetWizard = () => {
    setStep('create')
    setManifest(null)
    setAppId('')
    setBotToken('')
    setSigningSecret('')
  }

  const startMutation = useMutation({
    mutationFn: () => startSlackConnect(agentId),
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

  const beginConnect = () => {
    resetWizard()
    setOpen(true)
    startMutation.mutate()
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
  const stepIndex = step === 'create' ? 0 : step === 'paste' ? 1 : 2

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
              Invite it to a channel with{' '}
              <code className="text-foreground">/invite @{conn?.handle}</code>,
              then <strong>@-mention</strong> it to start or steer a session.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect
            </Button>
          </div>
        ) : isErrorStatus ? (
          <div className="space-y-3">
            <p className="text-status-error text-sm">
              Slack reported a connection error (the token may have been
              revoked). Reconnect to fix it.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={beginConnect}>
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
            <Button size="sm" onClick={beginConnect}>
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
                  <p className="text-muted-foreground text-sm">
                    In Slack, create the app from this manifest (New App → From
                    a manifest), then Install to Workspace. Come back with the
                    three values it gives you.
                  </p>
                  <div className="min-w-0">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-muted-foreground text-xs font-medium">
                        App manifest
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={copyManifest}
                      >
                        {copied ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <pre className="bg-panel-2 max-h-60 overflow-auto rounded-md border p-3 font-mono text-xs">
                      {JSON.stringify(manifest.manifest, null, 2)}
                    </pre>
                  </div>
                  <a
                    href={manifest.create_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
                  >
                    Open Slack apps
                    <ExternalLink className="size-3.5" />
                  </a>
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
                  onClick={() => setStep('paste')}
                  disabled={!manifest || startMutation.isPending}
                >
                  Next: paste values
                </Button>
              </DialogFooter>
            </div>
          ) : step === 'paste' ? (
            <form
              className="min-w-0 space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                completeMutation.mutate()
              }}
            >
              <Field
                label="App ID"
                htmlFor="slack-app-id"
                description="On the app’s Basic Information page."
              >
                <Input
                  id="slack-app-id"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="A01234ABCDE"
                />
              </Field>
              <Field
                label="Bot User OAuth Token"
                htmlFor="slack-bot-token"
                description="OAuth & Permissions → after Install to Workspace."
              >
                <Input
                  id="slack-bot-token"
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="xoxb-…"
                />
              </Field>
              <Field
                label="Signing Secret"
                htmlFor="slack-signing-secret"
                description="Basic Information → App Credentials."
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
                  disabled={
                    completeMutation.isPending ||
                    !appId.trim() ||
                    !botToken.trim() ||
                    !signingSecret.trim()
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
                  Invite it to a channel, then @-mention it:
                </p>
                <CopyRow value={`/invite @${conn?.handle ?? agentName}`} />
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
    </Panel>
  )
}
