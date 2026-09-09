import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle, Phone, TriangleAlert } from 'lucide-react'
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
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  completeManagedAgentTwilio,
  disconnectManagedAgentTwilio,
  startManagedAgentTwilio,
  type ManagedAgentChannel,
  type ManagedTwilioSetup,
} from './api'

type Step = 'credentials' | 'number' | 'forwarding'
const STEPS = ['Credentials', 'Choose a number', 'Forward your line']

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

export function ManagedTwilioWizard({
  agentId,
  alias,
  connection,
  channelId,
}: {
  agentId: string
  alias: string
  connection?: ManagedAgentChannel
  channelId?: string
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('credentials')
  const [accountSid, setAccountSid] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [setup, setSetup] = useState<ManagedTwilioSetup>()
  const [numberSid, setNumberSid] = useState('')
  const [connectedNumber, setConnectedNumber] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['managed-agent-channels'] })

  const start = useMutation({
    mutationFn: () =>
      startManagedAgentTwilio(`${agentId}@${alias}`, {
        accountSid: accountSid.trim(),
        authToken: authToken.trim(),
        ...(channelId ? { channelId } : {}),
      }),
    onSuccess: (result) => {
      setSetup(result)
      // Clear the token as soon as it has been exchanged; the browser has no
      // further use for it.
      setAuthToken('')
      setNumberSid(result.numbers[0]?.sid ?? '')
      setStep('number')
      void invalidate()
    },
    onError: (error) =>
      notifyError('Twilio did not accept those credentials.', error),
  })

  const complete = useMutation({
    mutationFn: () => {
      const chosen = setup?.numbers.find((number) => number.sid === numberSid)
      if (!setup || !chosen) throw new Error('Choose a number to continue')
      return completeManagedAgentTwilio(setup.connection.id, {
        numberSid: chosen.sid,
        phoneNumber: chosen.phoneNumber,
        webhookToken: setup.webhookToken,
      })
    },
    onSuccess: (result) => {
      setConnectedNumber(result.connection.phoneNumber ?? '')
      setStep('forwarding')
      notifySuccess('Twilio is connected.')
      void invalidate()
    },
    onError: (error) =>
      notifyError("Twilio wouldn't accept the webhook setup.", error),
  })

  const disconnect = useMutation({
    mutationFn: () => disconnectManagedAgentTwilio(connection!.id),
    onSuccess: () => {
      setConfirmDisconnect(false)
      void invalidate()
    },
    onError: (error) => notifyError("Couldn't disconnect Twilio.", error),
  })

  const begin = () => {
    setStep('credentials')
    setAccountSid('')
    setAuthToken('')
    setSetup(undefined)
    setNumberSid('')
    setConnectedNumber('')
    setOpen(true)
  }

  const isConnected = connection?.status === 'connected'

  return (
    <>
      <div className="flex items-center gap-2">
        {isConnected ? (
          <>
            <StatusBadge status="active" label="Connected" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={begin}>
            <Phone className="size-4" />
            Connect Twilio
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect Twilio</DialogTitle>
            <DialogDescription>
              Calls and texts to a Twilio number reach this agent.
            </DialogDescription>
            <WizardSteps current={STEPS.indexOf(
              step === 'credentials'
                ? 'Credentials'
                : step === 'number'
                  ? 'Choose a number'
                  : 'Forward your line',
            )} />
          </DialogHeader>

          {step === 'credentials' ? (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm">
                Both values are on your Twilio console dashboard. We check them
                with Twilio before storing anything.
              </p>
              <Field label="Account SID">
                <Input
                  value={accountSid}
                  onChange={(event) => setAccountSid(event.target.value)}
                  placeholder="AC…"
                  autoComplete="off"
                />
              </Field>
              <Field label="Auth token">
                <Input
                  type="password"
                  value={authToken}
                  onChange={(event) => setAuthToken(event.target.value)}
                  placeholder="Your Twilio auth token"
                  autoComplete="off"
                />
              </Field>
              <DialogFooter>
                <Button
                  onClick={() => start.mutate()}
                  disabled={
                    start.isPending || !accountSid.trim() || !authToken.trim()
                  }
                >
                  {start.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : null}
                  Continue
                </Button>
              </DialogFooter>
            </div>
          ) : null}

          {step === 'number' && setup ? (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm">
                Connected to{' '}
                <span className="text-foreground font-medium">
                  {setup.account.friendlyName}
                </span>
                . Choose the number this agent should answer. We'll point it at
                OpenComputer for you.
              </p>
              {setup.numbers.length === 0 ? (
                <div className="flex items-start gap-2 rounded-md border p-3 text-sm">
                  <TriangleAlert className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <p>
                    This account has no number that can take both calls and
                    texts. Buy one in Twilio, then come back — a number without
                    voice can't catch a missed call.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {setup.numbers.map((number) => (
                    <label
                      key={number.sid}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm',
                        numberSid === number.sid
                          ? 'border-foreground'
                          : 'border-border',
                      )}
                    >
                      <input
                        type="radio"
                        name="twilio-number"
                        value={number.sid}
                        checked={numberSid === number.sid}
                        onChange={() => setNumberSid(number.sid)}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {number.phoneNumber}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {number.friendlyName}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <DialogFooter>
                <Button
                  onClick={() => complete.mutate()}
                  disabled={complete.isPending || !numberSid}
                >
                  {complete.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : null}
                  Connect this number
                </Button>
              </DialogFooter>
            </div>
          ) : null}

          {step === 'forwarding' ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <Check className="mt-0.5 size-4 shrink-0" />
                <p>
                  <span className="font-medium">{connectedNumber}</span> now
                  reaches this agent. Texts to it start a conversation, and
                  calls take a voicemail the agent reads.
                </p>
              </div>
              <div className="space-y-2 text-sm">
                <p className="font-medium">
                  One last step, on your existing business line
                </p>
                <p className="text-muted-foreground">
                  Set busy and no-answer forwarding to {connectedNumber}. On
                  most carriers that is a code you dial once from the phone
                  itself, or a single setting if the line is VoIP. Calls you
                  answer are unaffected — only the ones you miss come here.
                </p>
                <p className="text-muted-foreground">
                  This replaces your carrier's voicemail with one the agent can
                  act on, so keep your greeting in mind before you switch it.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Twilio?"
        description="Calls and texts to this number stop reaching the agent. Your Twilio number and its history are untouched, and the forwarding on your business line stays until you remove it."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutate()}
        pending={disconnect.isPending}
      />
    </>
  )
}
