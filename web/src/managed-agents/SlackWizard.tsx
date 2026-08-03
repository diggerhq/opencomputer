import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, MessageSquare } from 'lucide-react'
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
const STEPS = ['Create app', 'Details', 'Install', 'Done']

function WizardSteps({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2 pt-2">
      {STEPS.map((label, index) => (
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
          {index < STEPS.length - 1 ? (
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
    mutationFn: () =>
      completeManagedAgentSlack(manifest!.connection.id, {
        appId: appId.trim(),
        signingSecret: signingSecret.trim(),
        botToken: botToken.trim(),
      }),
    onSuccess: () => {
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
    setManifest(undefined)
    setAppId('')
    setSigningSecret('')
    setBotToken('')
  }
  const begin = () => {
    reset()
    setOpen(true)
  }
  const stepIndex =
    step === 'create' ? 0 : step === 'details' ? 1 : step === 'install' ? 2 : 3

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
                Invite this app to a channel before @mentioning it. Direct
                messages work without an invite.
              </p>
            ) : null}
          </div>
          {connection ? <StatusBadge status={connection.status} /> : null}
        </div>
        <div className="flex items-center gap-2">
          {connection?.status === 'connected' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect
            </Button>
          ) : null}
          {connection?.status !== 'connected' ? (
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
              {step === 'done' ? 'Slack is connected' : 'Connect Slack'}
            </DialogTitle>
            <DialogDescription>
              This Slack app belongs only to {agentName} @{alias}.
            </DialogDescription>
            <WizardSteps current={stepIndex} />
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
                  {complete.isPending ? 'Connecting…' : 'Connect Slack'}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">
                {appName} is connected. Invite it to a channel and @-mention it,
                or message it directly, to start a session.
              </p>
              <DialogFooter>
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
