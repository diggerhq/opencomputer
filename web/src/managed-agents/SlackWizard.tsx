import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
  TriangleAlert,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field, Input } from '@/components/form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { cn } from '@/lib/utils'
import {
  completeManagedAgentSlack,
  disconnectManagedAgentSlack,
  startManagedAgentSlack,
  type ManagedAgentChannel,
  type ManagedSlackManifest,
} from './api'

type Step = 'create' | 'details' | 'install' | 'done'
const CREATE_STEPS = ['Create app', 'Details', 'Install', 'Verify']
const EDIT_STEPS = ['Credentials', 'Token', 'Verify']

function WizardSteps({ current, steps }: { current: number; steps: string[] }) {
  return (
    <ol className="flex items-center gap-2 pt-2">
      {steps.map((label, index) => (
        <li key={label} className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
              index <= current
                ? 'bg-foreground text-background'
                : 'bg-secondary text-muted-foreground',
            )}
          >
            {index < current ? <Check className="size-3" /> : index + 1}
          </span>
          <span
            className={cn(
              'truncate text-xs',
              index === current
                ? 'text-foreground font-medium'
                : 'text-muted-foreground',
            )}
          >
            {label}
          </span>
          {index < steps.length - 1 ? (
            <span className="bg-border h-px w-4 shrink-0" />
          ) : null}
        </li>
      ))}
    </ol>
  )
}

export function ManagedSlackWizard({
  agentId,
  alias,
  agentName,
  connection,
}: {
  agentId: string
  alias: string
  agentName: string
  connection?: ManagedAgentChannel
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('create')
  const [appName, setAppName] = useState(agentName)
  const [manifest, setManifest] = useState<ManagedSlackManifest>()
  const [appId, setAppId] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [botToken, setBotToken] = useState('')
  const [editing, setEditing] = useState(false)
  const [verificationBaseline, setVerificationBaseline] = useState<string>()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [copied, markCopied] = useTransientFlag(1500)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['managed-agent-channels'] })

  const start = useMutation({
    mutationFn: () =>
      startManagedAgentSlack(`${agentId}@${alias}`, appName.trim(), false),
    onSuccess: (result) => {
      setManifest(result)
      void invalidate()
    },
    onError: (error) => notifyError("Couldn't prepare the Slack app.", error),
  })
  const complete = useMutation({
    mutationFn: () => {
      const connectionId = manifest?.connection.id ?? connection?.id
      if (!connectionId) throw new Error('Slack connection is unavailable')
      return completeManagedAgentSlack(connectionId, {
        appId: appId.trim(),
        signingSecret: signingSecret.trim(),
        botToken: botToken.trim(),
      })
    },
    onSuccess: (updated) => {
      setVerificationBaseline(updated.updatedAt)
      setStep('done')
      setSigningSecret('')
      setBotToken('')
      void invalidate()
    },
    onError: (error) =>
      notifyError('Slack rejected those values. Double-check them.', error),
  })
  const disconnect = useMutation({
    mutationFn: () => disconnectManagedAgentSlack(connection!.id),
    onSuccess: () => {
      setConfirmDisconnect(false)
      void invalidate()
    },
    onError: (error) => notifyError("Couldn't disconnect Slack.", error),
  })

  const reset = () => {
    setStep('create')
    setEditing(false)
    setManifest(undefined)
    setAppId('')
    setSigningSecret('')
    setBotToken('')
    setVerificationBaseline(undefined)
  }
  const begin = () => {
    reset()
    setOpen(true)
  }
  const beginEdit = () => {
    reset()
    setEditing(true)
    setAppId(connection?.appId || '')
    setStep('details')
    setOpen(true)
  }
  const steps = editing ? EDIT_STEPS : CREATE_STEPS
  const stepIndex = editing
    ? step === 'details'
      ? 0
      : step === 'install'
        ? 1
        : 2
    : step === 'create'
      ? 0
      : step === 'details'
        ? 1
        : step === 'install'
          ? 2
          : 3
  const verificationUpdated = Boolean(
    verificationBaseline &&
    connection?.updatedAt &&
    connection.updatedAt > verificationBaseline,
  )
  const eventVerified = Boolean(
    verificationUpdated &&
    verificationBaseline &&
    connection?.verifiedAt &&
    connection.verifiedAt > verificationBaseline,
  )
  const verificationFailed = Boolean(
    verificationUpdated && connection?.verificationError,
  )

  useEffect(() => {
    if (!open || step !== 'done' || eventVerified || verificationFailed) return
    const interval = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: ['managed-agent-channels'],
      })
    }, 2_000)
    return () => window.clearInterval(interval)
  }, [eventVerified, open, queryClient, step, verificationFailed])

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
            <MessageSquare className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {connection?.appName || agentName}
            </p>
            <p className="text-muted-foreground truncate text-xs">
              {connection?.status === 'connected'
                ? `Slack · ${connection.teamName || 'Connected workspace'}`
                : `Connect a dedicated Slack app to @${alias}`}
            </p>
            {connection?.status === 'connected' ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {connection.verificationError
                  ? 'Slack events are being rejected. Edit the signing secret and test again.'
                  : connection.verifiedAt
                    ? 'Listening for Slack events.'
                    : 'Credentials saved. Send the app a message to verify event delivery.'}
              </p>
            ) : null}
          </div>
          {connection ? <StatusBadge status={connection.status} /> : null}
        </div>
        <div className="flex items-center gap-2">
          {connection?.status === 'connected' ||
          connection?.verificationError ? (
            <Button variant="outline" size="sm" onClick={beginEdit}>
              Edit credentials
            </Button>
          ) : null}
          {connection?.status === 'connected' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect
            </Button>
          ) : null}
          {connection?.status !== 'connected' &&
          !connection?.verificationError ? (
            <Button size="sm" variant="outline" onClick={begin}>
              {connection ? 'Continue setup' : 'Connect Slack'}
            </Button>
          ) : null}
        </div>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) reset()
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {step === 'done'
                ? 'Verify Slack events'
                : editing
                  ? 'Edit Slack credentials'
                  : 'Connect Slack'}
            </DialogTitle>
            <DialogDescription>
              This Slack app belongs only to {agentName} @{alias}.
            </DialogDescription>
            <WizardSteps current={stepIndex} steps={steps} />
          </DialogHeader>

          {step === 'create' ? (
            <div className="space-y-4">
              <Field
                label="Slack app name"
                htmlFor="managed-slack-app-name"
                description="This is the name people will see in Slack."
              >
                <Input
                  id="managed-slack-app-name"
                  value={appName}
                  maxLength={35}
                  onChange={(event) => {
                    setAppName(event.target.value)
                    setManifest(undefined)
                  }}
                />
              </Field>
              {!manifest ? (
                <Button
                  variant="outline"
                  onClick={() => start.mutate()}
                  disabled={!appName.trim() || start.isPending}
                >
                  {start.isPending ? 'Preparing…' : 'Generate Slack manifest'}
                </Button>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">
                    Copy this manifest, then create the app from it in Slack.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(JSON.stringify(manifest.manifest, null, 2))
                          .then(markCopied)
                      }}
                    >
                      {copied ? <Check /> : <Copy />}
                      {copied ? 'Copied' : 'Copy manifest'}
                    </Button>
                    <a
                      href={manifest.createUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
                    >
                      Open Slack apps <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                  <pre className="bg-muted/30 max-h-56 overflow-auto rounded-md border p-3 text-xs whitespace-pre-wrap">
                    {JSON.stringify(manifest.manifest, null, 2)}
                  </pre>
                </>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={!manifest} onClick={() => setStep('details')}>
                  Next: app details
                </Button>
              </DialogFooter>
            </div>
          ) : step === 'details' ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                setStep('install')
              }}
            >
              <p className="text-muted-foreground text-sm">
                In Basic Information → App Credentials, copy these values.
              </p>
              <Field label="App ID" htmlFor="managed-slack-app-id">
                <Input
                  id="managed-slack-app-id"
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                  placeholder="A01234ABCDE"
                />
              </Field>
              <Field label="Signing Secret" htmlFor="managed-slack-secret">
                <Input
                  id="managed-slack-secret"
                  type="password"
                  value={signingSecret}
                  onChange={(event) => setSigningSecret(event.target.value)}
                  placeholder="••••••••"
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  Copy the field labeled Signing Secret, not Client Secret.
                </p>
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => (editing ? setOpen(false) : setStep('create'))}
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
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                complete.mutate()
              }}
            >
              <p className="text-muted-foreground text-sm">
                Install the app to your workspace, then copy its Bot User OAuth
                Token.
              </p>
              <Field label="Bot User OAuth Token" htmlFor="managed-slack-token">
                <Input
                  id="managed-slack-token"
                  type="password"
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
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
                  disabled={!botToken.trim() || complete.isPending}
                >
                  {complete.isPending
                    ? 'Saving…'
                    : editing
                      ? 'Save credentials'
                      : 'Connect Slack'}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="space-y-4">
              {eventVerified ? (
                <div className="flex items-start gap-3">
                  <Check className="mt-0.5 size-5 text-emerald-600" />
                  <div>
                    <p className="text-sm font-medium">Event received</p>
                    <p className="text-muted-foreground text-sm">
                      The signing secret is correct and this agent is listening
                      for Slack messages.
                    </p>
                  </div>
                </div>
              ) : verificationFailed ? (
                <div className="flex items-start gap-3">
                  <TriangleAlert className="text-destructive mt-0.5 size-5" />
                  <div>
                    <p className="text-sm font-medium">
                      Signing secret did not match
                    </p>
                    <p className="text-muted-foreground text-sm">
                      Copy Signing Secret from Slack Basic Information → App
                      Credentials, then save and test again.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <LoaderCircle className="mt-0.5 size-5 animate-spin" />
                  <div>
                    <p className="text-sm font-medium">
                      Listening for a Slack event…
                    </p>
                    <p className="text-muted-foreground text-sm">
                      In Slack, send @{connection?.appName || appName} ping in a
                      channel where the app is invited, or send it a direct
                      message.
                    </p>
                  </div>
                </div>
              )}
              <DialogFooter>
                {verificationFailed ? (
                  <Button variant="outline" onClick={() => setStep('details')}>
                    Edit credentials
                  </Button>
                ) : null}
                <Button onClick={() => setOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Slack?"
        description="This agent will stop receiving Slack messages. Its bot token and signing secret will be removed."
        confirmLabel="Disconnect"
        destructive
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </>
  )
}
