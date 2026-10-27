import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  hashKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Ellipsis, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ApiError } from '@/api/errors'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyCommand, CopyRow } from '@/components/copy-row'
import { ServiceLogo } from '@/components/service-logo'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { AuthContext } from '@/hooks/useAuth'
import { TRIAL_CREDITS_USD } from '@/lib/billing-onramp'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  trackAgentChosen,
  trackAgentConnected,
  trackAgentFailed,
  trackAgentStepShown,
  trackLinked,
  trackLinkShown,
} from './computer-analytics'
import {
  computerConnectCodeQueryKey,
  computerQueryKey,
  connectClaudeSubscription,
  connectCommand,
  createConnectCode,
  disconnectClaudeSubscription,
  disconnectCodexSubscription,
  getComputer,
  isHarnessAvailable,
  resumeClaudeSubscription,
  setAgentChoice,
  subscriptionProviderSchema,
  type AgentChoice,
  type ComputerAgent,
  type AgentSubscription,
  type ComputerConnectCode,
  type ConnectCodePurpose,
  type ComputerStatus,
  type SubscriptionProvider,
} from './computer-api'
import { agentSummary, linkedSlackUserLine } from './computer-state'

/**
 * Setup step 1 and the Your agent card (serverless-agents-ws work 081): the
 * person brings their own Claude subscription or ChatGPT plan, or starts on
 * free credits. Since work 082 a subscription connects with one command
 * (`npx -y @opencomputer/cli model connect … --code …`) that signs in in the
 * browser and hands the login to the computer; a Claude setup token can
 * still be pasted. Copy is the doc's Copy table, kept short.
 */

/** The card picked in step 1. */
export type AgentCardChoice = SubscriptionProvider

const PROVIDER_NAME: Record<SubscriptionProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

// Where each command signs the person in.
const SIGN_IN_AT: Record<SubscriptionProvider, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
}

const disconnectSubscription = (provider: SubscriptionProvider) =>
  provider === 'codex'
    ? disconnectCodexSubscription()
    : disconnectClaudeSubscription()

// `claude setup-token` prints a long-lived OAuth token with this prefix.
const SETUP_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/
const STILL_CHECKING_MS = 10_000

const Cmd = ({ children }: { children: ReactNode }) => (
  <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
    {children}
  </code>
)

const FORMAT_ERROR = (
  <>
    That&apos;s not a setup token. It starts with <Cmd>sk-ant-oat01-</Cmd>.
  </>
)

const CUT_OFF_ERROR = <>That token looks cut off. Copy all of it again.</>

// The terminal wraps the long token, so a copy can carry the line break and
// indentation. A setup token has no whitespace of its own.
const cleanToken = (value: string) => value.replace(/\s+/g, '')

const SLACK_INSTRUCTION = (
  <>
    Connect from Slack: <Cmd>!claude connect</Cmd>
  </>
)

const UNREACHABLE =
  "Couldn't reach the server. This page re-reads your agent in a moment; try again if nothing changed."

/**
 * The server's code when it refused a write, or undefined when the write may
 * not have reached it (network drop, a 5xx, a body without a code): then
 * nothing is known about what was saved, and the page re-reads the truth.
 */
function refusalCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status >= 500) return undefined
  return error.type
}

/** The doc's copy for each refusal; anything else keeps the edge's message. */
function connectErrorCopy(error: unknown): ReactNode {
  switch (refusalCode(error)) {
    case undefined:
      return UNREACHABLE
    case 'computer_agent_token_format':
      return FORMAT_ERROR
    case 'computer_agent_token_rejected':
      return (
        <>
          That token didn&apos;t work. Run <Cmd>claude setup-token</Cmd> again
          and paste the new one.
        </>
      )
    case 'computer_agent_connect_in_slack':
      return SLACK_INSTRUCTION
    default:
      return (error as ApiError).message
  }
}

/**
 * How the agent writes meet the page's status query, which polls on its own.
 * `setAgent` keeps the agent the server answered with: a poll that started
 * before the write could answer after it and revert the result, so any poll
 * in flight is cancelled first. `reread` asks for the truth when the answer
 * was lost.
 */
function useAgentCache() {
  const queryClient = useQueryClient()
  return {
    setAgent: async (agent: ComputerAgent) => {
      await queryClient.cancelQueries({
        queryKey: computerQueryKey,
        exact: true,
      })
      queryClient.setQueryData<ComputerStatus>(computerQueryKey, (status) =>
        status ? { ...status, agent } : status,
      )
    },
    reread: () => {
      void queryClient.invalidateQueries({ queryKey: computerQueryKey })
    },
  }
}

/**
 * The three ways to go: the two cards, the selected card's panel (its
 * command and, for Claude, the paste form; or the coming line of a harness
 * this computer cannot run yet) and free credits. Step 1 of setup, and the
 * Change dialog of its done row, where `onDone` closes the dialog once the
 * server has the change. Free credits replace a connected subscription:
 * routing decides from the subscription row, so it is disconnected first.
 */
export function AgentSetup({
  agent,
  selected,
  onSelect,
  onDone,
}: {
  agent: ComputerAgent
  selected: AgentCardChoice
  onSelect: (choice: AgentCardChoice) => void
  onDone?: () => void
}) {
  const { setAgent, reread } = useAgentCache()
  useEffect(() => {
    trackAgentStepShown()
  }, [])

  const choose = useMutation({
    mutationFn: async (choice: AgentChoice) => {
      if (choice === 'credits' && agent.subscription)
        await disconnectSubscription(agent.subscription.provider)
      return setAgentChoice(choice)
    },
    onSuccess: async (next, choice) => {
      await setAgent(next)
      trackAgentChosen(choice)
      if (choice !== 'credits') return
      if (agent.subscription)
        notifySuccess('Threads run on OpenComputer credits now.')
      onDone?.()
    },
    onError: (error, choice) => {
      // Two writes for credits: whatever landed, the page re-reads it.
      reread()
      notifyError(
        choice === 'credits'
          ? "Couldn't switch to OpenComputer credits."
          : "Couldn't save your choice.",
        error,
      )
    },
  })
  const pick = (choice: AgentCardChoice) => {
    if (choice === selected) return
    onSelect(choice)
    // Codex is recorded on selection, so the step reopens on it after a
    // reload; so is any card this computer cannot run yet, as the interest
    // is all that card does.
    if (
      (choice === 'codex' || !isHarnessAvailable(agent, choice)) &&
      agent.choice !== choice
    )
      choose.mutate(choice)
  }
  const onCredits = !agent.subscription && agent.choice === 'credits'

  return (
    <>
      <p>Bring your own subscription.</p>
      <div
        role="radiogroup"
        aria-label="Coding agent"
        className="grid gap-3 sm:grid-cols-2"
      >
        <AgentOption
          checked={selected === 'claude'}
          onSelect={() => pick('claude')}
          name="Claude Code"
          plans="Pro or Max"
          mark={<span className="bg-[#d97757] text-white">✳</span>}
        />
        <AgentOption
          checked={selected === 'codex'}
          onSelect={() => pick('codex')}
          name="Codex"
          plans="ChatGPT Plus or Pro"
          mark={<span className="bg-foreground text-background">◎</span>}
        />
      </div>
      {!isHarnessAvailable(agent, selected) ? (
        // Not rolled out to this computer (or switched off): the card only
        // records the interest, no code is minted.
        <p className="bg-muted/60 text-foreground rounded-lg px-4 py-3">
          {PROVIDER_NAME[selected]} is coming. We&apos;ll let you know.
        </p>
      ) : (
        <SubscriptionConnect
          // A new card is a new command: its own sign-in and wait.
          key={selected}
          provider={selected}
          replacing={agent.subscription?.provider === selected}
          onDone={onDone}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-3">
        <div>
          <p className="text-foreground font-semibold">
            {agent.subscription
              ? 'Switch to OpenComputer credits.'
              : `No subscription? Your trial includes $${TRIAL_CREDITS_USD} of model credits.`}
          </p>
          <p>
            {agent.subscription
              ? `Disconnects ${PROVIDER_NAME[agent.subscription.provider]}; runs`
              : 'Runs'}{' '}
            {agent.managedModel} on our credits.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => choose.mutate('credits')}
          disabled={choose.isPending || onCredits}
        >
          {choose.isPending && choose.variables === 'credits' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          {onCredits
            ? 'Using OpenComputer credits'
            : 'Use OpenComputer credits'}
        </Button>
      </div>
    </>
  )
}

function AgentOption({
  checked,
  onSelect,
  name,
  plans,
  mark,
}: {
  checked: boolean
  onSelect: () => void
  name: string
  plans: string
  mark: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'bg-panel focus-visible:ring-ring/50 flex items-start gap-3 rounded-lg border p-4 text-left transition-colors outline-none focus-visible:ring-3',
        checked
          ? 'border-foreground ring-foreground ring-1'
          : 'hover:bg-muted/40',
      )}
    >
      <span
        className="[&>span]:flex [&>span]:size-6 [&>span]:items-center [&>span]:justify-center [&>span]:rounded-md [&>span]:text-xs"
        aria-hidden
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block font-semibold">{name}</span>
        <span className="block">{plans}</span>
      </span>
      <span
        className={cn(
          'mt-0.5 size-4 shrink-0 rounded-full border',
          checked && 'border-foreground border-[5px]',
        )}
        aria-hidden
      />
    </button>
  )
}

// The command's code works for ten minutes. Re-read the status quickly for a
// while after the person last acted (the command shown, copied or renewed:
// they may sign in in a window beside this one), then slower, then not at
// all: a person who comes back from the terminal or the browser refocuses
// the tab, which re-reads it. An expired code is replaced on its own for
// half an hour after they last acted; after that the command reads expired
// until they ask for another, so a tab left open mints and polls nothing.
const WAIT_FAST_MS = 3_000
const WAIT_SLOW_MS = 10_000
const WAIT_FAST_FOR_MS = 2 * 60_000
const WAIT_FOR_MS = 10 * 60_000
const CODE_AUTO_RENEW_FOR_MS = 30 * 60_000
const computerQueryHash = hashKey(computerQueryKey)
// A stored code is reused only with this long left to run it.
const CODE_REUSE_MIN_MS = 60_000

function connectCodeStorageKey(scope: string, purpose: ConnectCodePurpose) {
  const base = `opencomputer.computer.connect-code:${scope}`
  return purpose === 'link' ? `${base}:link` : base
}

/**
 * The stored code, unless it is nearly expired or was likely spent: a
 * subscription set after it was minted (the command ran while no tab was
 * watching, so none forgot it) means it was used.
 */
function storedConnectCode(
  key: string,
  subscriptionSetAt: string | undefined,
): ComputerConnectCode | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const stored = JSON.parse(raw) as Partial<
      ComputerConnectCode & { mintedAt: number }
    >
    if (
      typeof stored.code !== 'string' ||
      typeof stored.expiresAt !== 'string' ||
      new Date(stored.expiresAt).getTime() - Date.now() < CODE_REUSE_MIN_MS
    )
      return null
    if (
      subscriptionSetAt &&
      new Date(subscriptionSetAt).getTime() >= (stored.mintedAt ?? 0)
    )
      return null
    return { code: stored.code, expiresAt: stored.expiresAt }
  } catch {
    return null
  }
}

/**
 * This person's connect code, one for both cards (the command names the
 * provider). Minting replaces the last code, so neither a reload nor a
 * second tab may mint a new one under a command the person is already
 * running: the code is kept in local storage until it is nearly expired.
 * A code is re-minted once it expires, only while the tab is visible
 * (react-query skips background intervals and catches up on focus) and
 * only until `renewUntil`: after that a tab left open mints nothing, not
 * even when it is focused again.
 */
function useConnectCode(
  renewUntil: number,
  purpose: ConnectCodePurpose = 'connect',
  enabled = true,
) {
  const auth = useContext(AuthContext)
  const key = connectCodeStorageKey(
    `${auth?.user?.orgId ?? ''}:${auth?.user?.id ?? ''}`,
    purpose,
  )
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: [...computerConnectCodeQueryKey, key],
    queryFn: async () => {
      const status = queryClient.getQueryData<ComputerStatus>(computerQueryKey)
      const stored = storedConnectCode(key, status?.agent?.subscription?.setAt)
      if (stored) return stored
      const mintedAt = Date.now()
      const minted = await createConnectCode(purpose)
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ ...minted, mintedAt }),
        )
      } catch {
        // Storage off: a reload mints a new code, nothing worse.
      }
      return minted
    },
    enabled,
    retry: false,
    staleTime: (q) => msUntil(q.state.data?.expiresAt),
    refetchInterval: (q) =>
      q.state.data && Date.now() < renewUntil
        ? Math.max(1_000, msUntil(q.state.data.expiresAt))
        : false,
    refetchOnWindowFocus: () => Date.now() < renewUntil,
  })
  const renew = useCallback(() => {
    forgetStoredCode(key)
    void queryClient.invalidateQueries({
      queryKey: [...computerConnectCodeQueryKey, key],
      exact: true,
    })
  }, [key, queryClient])
  const forget = useCallback(() => {
    forgetStoredCode(key)
    queryClient.removeQueries({
      queryKey: [...computerConnectCodeQueryKey, key],
      exact: true,
    })
  }, [key, queryClient])
  // `renew`: the person asked for another command. `forget`: the code was
  // used; never show it again.
  return { query, renew, forget }
}

function forgetStoredCode(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Nothing stored.
  }
}

function msUntil(iso: string | undefined): number {
  if (!iso) return 0
  const left = new Date(iso).getTime() - Date.now()
  return Number.isNaN(left) ? 0 : Math.max(0, left)
}

/**
 * Connecting a subscription: the one command first, and for Claude the
 * paste-a-token form as the other way. `mintOnShow` false waits for a click
 * before minting a code (the Your agent card, which people mostly only look
 * at); setup mints on selection.
 */
function SubscriptionConnect({
  provider,
  replacing = false,
  mintOnShow = true,
  onDone,
  onCancel,
}: {
  provider: SubscriptionProvider
  replacing?: boolean
  mintOnShow?: boolean
  onDone?: () => void
  onCancel?: () => void
}) {
  const [pasting, setPasting] = useState(false)
  const [started, setStarted] = useState(mintOnShow)
  // One way at a time, so a connect is announced (and counted) once.
  const canPaste = provider === 'claude'
  return (
    <div className="space-y-4">
      {canPaste && pasting ? (
        <ClaudeConnect replacing={replacing} onDone={onDone} />
      ) : started ? (
        <CommandConnect
          provider={provider}
          replacing={replacing}
          onDone={onDone}
        />
      ) : (
        <Button onClick={() => setStarted(true)}>
          {replacing ? 'Reconnect' : 'Connect'} {PROVIDER_NAME[provider]}
        </Button>
      )}
      {canPaste || onCancel ? (
        <div className="flex flex-wrap items-center gap-4">
          {canPaste ? (
            <Button
              variant="link"
              size="sm"
              className="text-muted-foreground h-auto px-0"
              onClick={() => {
                setPasting(!pasting)
                setStarted(true)
              }}
            >
              {pasting ? 'Use the command instead' : 'Or paste a token'}
            </Button>
          ) : null}
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The one command, and the wait for it: the page re-reads the status until
 * the subscription of this provider shows up (a new one when replacing, told
 * apart by when it was set), then says so and moves on as the paste form
 * does.
 */
function CommandConnect({
  provider,
  replacing,
  onDone,
}: {
  provider: SubscriptionProvider
  replacing: boolean
  onDone?: () => void
}) {
  // The last sign of the person acting: the command shown, copied or
  // renewed. Waiting and renewing are paced from it.
  const [actedAt, setActedAt] = useState(() => Date.now())
  const {
    query: code,
    renew: renewCode,
    forget,
  } = useConnectCode(actedAt + CODE_AUTO_RENEW_FOR_MS)
  const renew = () => {
    setActedAt(Date.now())
    renewCode()
  }
  const queryClient = useQueryClient()
  // What was there when the command was shown: only a change counts.
  const [before] = useState(
    () =>
      queryClient.getQueryData<ComputerStatus>(computerQueryKey)?.agent
        ?.subscription?.setAt ?? null,
  )
  const status = useQuery({
    queryKey: computerQueryKey,
    queryFn: getComputer,
    refetchInterval: () => {
      const waited = Date.now() - actedAt
      if (waited >= WAIT_FOR_MS) return false
      return waited < WAIT_FAST_FOR_MS ? WAIT_FAST_MS : WAIT_SLOW_MS
    },
  })
  const subscription = status.data?.agent?.subscription ?? null
  const connected =
    subscription?.provider === provider && subscription.setAt !== before
  const codeValue = code.data?.code
  // The code this command shows ran out (no auto-renew any more): say so
  // rather than keep a dead command and a spinner up.
  const [expiredCode, setExpiredCode] = useState<string | null>(null)
  const expiresAt = code.data?.expiresAt
  useEffect(() => {
    if (!codeValue) return
    const timer = window.setTimeout(
      () => setExpiredCode(codeValue),
      msUntil(expiresAt),
    )
    return () => window.clearTimeout(timer)
  }, [codeValue, expiresAt])
  // Not while a renewal is in flight: the new code is about to replace it.
  const expired =
    Boolean(codeValue) && expiredCode === codeValue && !code.isFetching
  // Announced from the cache, as the status lands: in setup the step moves
  // on (and this unmounts) in the very render that brings the subscription.
  const announced = useRef(false)
  useEffect(() => {
    const check = (next: ComputerStatus | undefined) => {
      const found = next?.agent?.subscription
      if (announced.current || found?.provider !== provider) return
      if (found.setAt === before) return
      announced.current = true
      forget()
      trackAgentChosen(provider)
      trackAgentConnected({
        provider,
        verified: found.health === 'ok',
        via: 'command',
      })
      notifySuccess(`${PROVIDER_NAME[provider]} is connected.`)
      onDone?.()
    }
    check(queryClient.getQueryData<ComputerStatus>(computerQueryKey))
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.query.queryHash === computerQueryHash
      )
        check(event.query.state.data as ComputerStatus | undefined)
    })
  }, [queryClient, provider, before, forget, onDone])

  if (code.isError && !code.data) {
    return (
      <div className="bg-muted/60 text-foreground space-y-3 rounded-lg p-4">
        <p role="alert" className="text-destructive">
          {connectErrorCopy(code.error)}
        </p>
        <Button size="sm" variant="outline" onClick={renew}>
          Try again
        </Button>
      </div>
    )
  }
  const lead = (
    <>Run this in a terminal; it opens {SIGN_IN_AT[provider]} to sign in.</>
  )
  return (
    <div className="bg-muted/60 text-foreground space-y-3 rounded-lg p-4">
      {codeValue ? (
        <CopyCommand
          value={connectCommand(provider, codeValue)}
          lead={lead}
          onCopy={() => setActedAt(Date.now())}
        />
      ) : (
        <>
          <p>{lead}</p>
          <div
            className="bg-panel-2 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]"
            aria-busy
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Getting your command…
          </div>
        </>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {connected ? (
          <span>{PROVIDER_NAME[provider]} is connected.</span>
        ) : expired ? (
          <span aria-live="polite">This command expired.</span>
        ) : (
          <span className="flex items-center gap-1.5" aria-live="polite">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {replacing
              ? 'Waiting for the new sign-in…'
              : 'Waiting for you to sign in…'}
          </span>
        )}
        {!expired && <span>Works once, for 10 minutes.</span>}
        <Button
          variant="link"
          size="xs"
          className="text-muted-foreground h-auto px-0 text-xs underline"
          disabled={code.isFetching}
          onClick={renew}
        >
          Get a new command
        </Button>
      </div>
    </div>
  )
}

/**
 * Linking this person to their Slack user (work 083): `!link <code>` sent to
 * the app in Slack. The page re-reads the status until it says linked; then
 * the card becomes the usual connect card, with this Slack user's
 * subscriptions.
 */
export function LinkSlack() {
  const [actedAt, setActedAt] = useState(() => Date.now())
  // Set with the link, before this unmounts: the forgotten code's query is
  // still observed until then, and must not mint again.
  const [linked, setLinked] = useState(false)
  useEffect(() => {
    trackLinkShown()
  }, [])
  const {
    query: code,
    renew: renewCode,
    forget,
  } = useConnectCode(actedAt + CODE_AUTO_RENEW_FOR_MS, 'link', !linked)
  const renew = () => {
    setActedAt(Date.now())
    renewCode()
  }
  useQuery({
    queryKey: computerQueryKey,
    queryFn: getComputer,
    refetchInterval: () => {
      const waited = Date.now() - actedAt
      if (waited >= WAIT_FOR_MS) return false
      return waited < WAIT_FAST_FOR_MS ? WAIT_FAST_MS : WAIT_SLOW_MS
    },
  })
  // Announced once, from the cache: the card swaps in the render that
  // brings the link, and this unmounts.
  const queryClient = useQueryClient()
  const announced = useRef(false)
  useEffect(() => {
    const check = (next: ComputerStatus | undefined) => {
      if (announced.current || !next?.agent?.linked) return
      announced.current = true
      setLinked(true)
      forget()
      trackLinked()
      notifySuccess('Linked to your Slack account.')
    }
    check(queryClient.getQueryData<ComputerStatus>(computerQueryKey))
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.query.queryHash === computerQueryHash
      )
        check(event.query.state.data as ComputerStatus | undefined)
    })
  }, [queryClient, forget])

  const codeValue = code.data?.code
  const lead = <>Link your Slack account: send this to the app in Slack.</>
  return (
    <div className="space-y-3">
      {code.isError && !code.data ? (
        <div className="bg-muted/60 text-foreground space-y-3 rounded-lg p-4">
          <p role="alert" className="text-destructive">
            {connectErrorCopy(code.error)}
          </p>
          <Button size="sm" variant="outline" onClick={renew}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="bg-muted/60 text-foreground space-y-3 rounded-lg p-4">
          {codeValue ? (
            <CopyCommand
              value={`!link ${codeValue}`}
              lead={lead}
              onCopy={() => setActedAt(Date.now())}
            />
          ) : (
            <>
              <p>{lead}</p>
              <div
                className="bg-panel-2 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]"
                aria-busy
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Getting your code…
              </div>
            </>
          )}
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="flex items-center gap-1.5" aria-live="polite">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              Waiting for it in Slack…
            </span>
            <span>Works once, for 10 minutes.</span>
            <Button
              variant="link"
              size="xs"
              className="text-muted-foreground h-auto px-0 text-xs underline"
              disabled={code.isFetching}
              onClick={renew}
            >
              Get a new code
            </Button>
          </div>
        </div>
      )}
      <p>
        Or connect from Slack: <Cmd>!claude connect</Cmd> or{' '}
        <Cmd>!codex connect</Cmd>
      </p>
    </div>
  )
}

/**
 * The paste form. The token lives in the field only until it is sent, and
 * then in a ref only until the server answers: the field is a password
 * field, never autocompleted, and emptied on submit; the ref is emptied and
 * the mutation reset the moment the call settles, so react-query's cache
 * never holds the token as the call's variables. The request is never
 * aborted (the server answers within about 9 s in every branch; an abort
 * could cancel the save and make "Saved" untrue).
 */
function ClaudeConnect({
  replacing = false,
  onDone,
}: {
  replacing?: boolean
  /** The server has the token. */
  onDone?: () => void
}) {
  const { setAgent, reread } = useAgentCache()
  const fieldId = useId()
  const [token, setToken] = useState('')
  const [formatChecked, setFormatChecked] = useState(false)
  const [failure, setFailure] = useState<ReactNode>(null)
  const [slow, setSlow] = useState(false)
  const sending = useRef('')
  const connect = useMutation({
    mutationFn: () => connectClaudeSubscription(sending.current),
    onSuccess: async (result) => {
      await setAgent(result.agent)
      trackAgentChosen('claude')
      trackAgentConnected({
        provider: 'claude',
        verified: result.verified,
        via: result.via,
      })
      if (result.verified) notifySuccess('Claude Code is connected.')
      else notifySuccess("Saved. We'll check it when your computer starts.")
      onDone?.()
    },
    onError: (error) => {
      const code = refusalCode(error)
      trackAgentFailed(code ?? 'unknown')
      if (code === undefined) reread()
      setFailure(connectErrorCopy(error))
    },
    onSettled: () => {
      sending.current = ''
      connect.reset()
    },
  })
  const pending = connect.isPending
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setSlow(true), STILL_CHECKING_MS)
    return () => {
      clearTimeout(timer)
      setSlow(false)
    }
  }, [pending])

  const cleaned = cleanToken(token)
  const badFormat =
    formatChecked && cleaned !== '' && !SETUP_TOKEN.test(cleaned)
  const error = badFormat
    ? cleaned.startsWith('sk-ant-oat01-')
      ? CUT_OFF_ERROR
      : FORMAT_ERROR
    : failure

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        setFormatChecked(true)
        if (pending) return
        if (!SETUP_TOKEN.test(cleaned)) {
          if (cleaned !== '') trackAgentFailed('computer_agent_token_format')
          return
        }
        sending.current = cleaned
        setToken('')
        setFormatChecked(false)
        setFailure(null)
        connect.mutate()
      }}
    >
      <ol className="bg-muted/60 text-foreground space-y-3 rounded-lg p-4">
        <li className="flex gap-3">
          <span className="text-muted-foreground w-3 shrink-0">1</span>
          <div className="min-w-0 flex-1 space-y-2">
            <p>Run</p>
            <CopyRow value="claude setup-token" />
          </div>
        </li>
        <li className="flex gap-3">
          <span className="text-muted-foreground w-3 shrink-0">2</span>
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor={fieldId} className="block">
              Paste the token
            </label>
            <Input
              id={fieldId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-oat01-…"
              className="bg-panel h-9 font-mono"
              value={token}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              onChange={(event) => {
                setToken(event.target.value)
                if (failure) setFailure(null)
              }}
              // The format check runs on paste, before anything is sent.
              onPaste={() => setFormatChecked(true)}
              onBlur={() => setFormatChecked(true)}
            />
          </div>
        </li>
      </ol>
      {error ? (
        <p
          id={`${fieldId}-error`}
          role="alert"
          className="text-destructive text-sm"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          {pending
            ? slow
              ? 'Still checking…'
              : 'Checking…'
            : replacing
              ? 'Replace token'
              : 'Connect Claude Code'}
        </Button>
      </div>
      <p className="text-xs">Stored sealed. Sessions never see it.</p>
    </form>
  )
}

const HEALTH: Record<
  NonNullable<ComputerAgent['subscription']>['health'],
  string
> = {
  ok: 'Connected',
  unchecked: "Saved. We'll check it when your computer starts.",
  paused: 'Paused. Threads run on OpenComputer credits.',
  limited: 'At its limit. Threads run on OpenComputer credits',
  invalid: 'This token stopped working. Replace it, or resume once fixed.',
}

function healthLine(
  subscription: NonNullable<ComputerAgent['subscription']>,
): string {
  if (subscription.provider === 'codex' && subscription.health === 'invalid')
    return 'This ChatGPT login stopped working. Reconnect it.'
  if (subscription.health !== 'limited') return HEALTH[subscription.health]
  if (!subscription.limitedUntil) return `${HEALTH.limited}.`
  const until = new Date(subscription.limitedUntil)
  return Number.isNaN(until.getTime())
    ? `${HEALTH.limited}.`
    : `${HEALTH.limited} until ${until.toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })}.`
}

/** Each subscription's row: its mark, and what it takes. */
const PROVIDER_ROW: Record<
  SubscriptionProvider,
  { logo: 'claude' | 'openai'; plans: string }
> = {
  claude: { logo: 'claude', plans: 'Claude Pro or Max' },
  codex: { logo: 'openai', plans: 'ChatGPT Plus or Pro' },
}

/** Every provider's subscription, from an older backend's one if need be. */
function subscriptionsOf(
  agent: ComputerAgent,
): Record<SubscriptionProvider, AgentSubscription | null> {
  if (agent.subscriptions) return agent.subscriptions
  const one = agent.subscription
  return {
    claude: one?.provider === 'claude' ? one : null,
    codex: one?.provider === 'codex' ? one : null,
  }
}

/**
 * The person's subscriptions, one row each whether connected or not (work
 * 083): health, Connect, Replace, Resume, Disconnect, and which one runs
 * their threads. The Models card on Connections.
 */
export function AgentManage({
  agent,
  slackInstalled,
}: {
  agent: ComputerAgent
  slackInstalled: boolean
}) {
  const needsLink = slackInstalled && !agent.linked
  const linked = linkedSlackUserLine(agent, slackInstalled)
  const subscriptions = subscriptionsOf(agent)
  const groupName = useId()
  const { setAgent } = useAgentCache()
  const select = useMutation({
    mutationFn: (provider: SubscriptionProvider) => setAgentChoice(provider),
    onSuccess: async (next, provider) => {
      await setAgent(next)
      trackAgentChosen(provider)
      notifySuccess(`${PROVIDER_NAME[provider]} runs your threads now.`)
    },
    onError: (error) => notifyError("Couldn't switch.", error),
  })
  return (
    <div className="text-muted-foreground space-y-3 text-sm">
      {!agent.subscription || needsLink || linked ? (
        <div className="space-y-0.5">
          {!agent.subscription ? (
            <p className="text-foreground font-medium">{agentSummary(agent)}</p>
          ) : null}
          {needsLink ? (
            // After Slack, subscriptions belong to Slack users: a person not
            // linked to one links first, on the Slack card above.
            <p>Link your Slack account above to use your own subscription.</p>
          ) : linked ? (
            <p>
              For @{agent.linkedSlackUser?.name} in{' '}
              {agent.linkedSlackUser?.teamName}
            </p>
          ) : null}
        </div>
      ) : null}
      <fieldset className="space-y-2" aria-busy={select.isPending}>
        <legend className="sr-only">Agent for your threads</legend>
        {subscriptionProviderSchema.options.map((provider) => (
          <ProviderRow
            key={provider}
            agent={agent}
            provider={provider}
            subscription={subscriptions[provider]}
            locked={needsLink}
            groupName={groupName}
            switching={select.isPending}
            selecting={select.isPending && select.variables === provider}
            onSelect={() => select.mutate(provider)}
          />
        ))}
      </fieldset>
    </div>
  )
}

function ProviderRow({
  agent,
  provider,
  subscription,
  locked,
  groupName,
  switching,
  selecting,
  onSelect,
}: {
  agent: ComputerAgent
  provider: SubscriptionProvider
  subscription: AgentSubscription | null
  locked: boolean
  groupName: string
  switching: boolean
  selecting: boolean
  onSelect: () => void
}) {
  const { setAgent, reread } = useAgentCache()
  const [connecting, setConnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const available = isHarnessAvailable(agent, provider)
  const name = PROVIDER_NAME[provider]
  const runs = agent.subscription?.provider === provider
  const resume = useMutation({
    mutationFn: resumeClaudeSubscription,
    onSuccess: async (next) => {
      await setAgent(next)
      notifySuccess('Resumed.')
    },
    onError: (error) => {
      if (refusalCode(error) === undefined) reread()
      notifyError("Couldn't resume.", error)
    },
  })
  const disconnect = useMutation({
    mutationFn: disconnectSubscription,
    onSuccess: () => {
      setConfirmDisconnect(false)
      notifySuccess(`${name} is disconnected.`)
      reread()
    },
    onError: (error) => notifyError("Couldn't disconnect.", error),
  })
  // Resume is Claude's: a ChatGPT login that stopped working signs in again.
  const canResume =
    provider === 'claude' &&
    (subscription?.health === 'paused' || subscription?.health === 'invalid')
  const status = subscription
    ? healthLine(subscription)
    : available
      ? 'Not connected'
      : "Coming soon. We'll let you know."

  return (
    <section
      aria-label={name}
      className={cn(
        'space-y-3 rounded-lg border px-3 py-3 transition-colors',
        runs && 'bg-muted/40',
      )}
    >
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 has-disabled:cursor-default">
          <input
            type="radio"
            name={groupName}
            value={provider}
            aria-label={name}
            aria-describedby={`${groupName}-${provider}-status`}
            checked={runs}
            disabled={
              locked || connecting || switching || !subscription || !available
            }
            onChange={onSelect}
            className="accent-foreground focus-visible:outline-ring size-4 shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-default"
          />
          <span className="bg-background flex size-9 shrink-0 items-center justify-center rounded-md border">
            <ServiceLogo
              service={PROVIDER_ROW[provider].logo}
              className="text-foreground size-5"
            />
          </span>
          <span className="min-w-0 space-y-0.5">
            <span className="text-foreground block font-medium">{name}</span>
            <span
              id={`${groupName}-${provider}-status`}
              className={cn(
                'block text-xs',
                subscription?.health === 'invalid' && 'text-destructive',
              )}
            >
              {subscription?.plan
                ? `ChatGPT ${subscription.plan.charAt(0).toUpperCase()}${subscription.plan.slice(1)} · ${status}`
                : subscription
                  ? status
                  : `${PROVIDER_ROW[provider].plans} · ${status}`}
            </span>
          </span>
        </label>
        {selecting ? (
          <span
            role="status"
            className="text-muted-foreground flex items-center gap-1.5 text-xs"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <span className="sr-only sm:not-sr-only">Switching…</span>
          </span>
        ) : null}
        {locked || connecting ? null : (
          <div className="flex shrink-0 items-center gap-1">
            {canResume ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => resume.mutate()}
                disabled={resume.isPending || switching}
              >
                {resume.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Resume
              </Button>
            ) : null}
            {!subscription && available ? (
              <Button
                size="sm"
                variant="outline"
                disabled={switching}
                onClick={() => setConnecting(true)}
              >
                Connect
              </Button>
            ) : null}
            {subscription ? (
              // Let pointer dismissal keep focus where the user clicked;
              // Radix still restores the trigger for keyboard dismissal.
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    aria-label={`Manage ${name} subscription`}
                    disabled={switching || resume.isPending}
                  >
                    <Ellipsis aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  {available ? (
                    <DropdownMenuItem onSelect={() => setConnecting(true)}>
                      {provider === 'codex' ? 'Reconnect' : 'Replace'}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => setConfirmDisconnect(true)}>
                    Disconnect
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        )}
      </div>
      {connecting ? (
        <SubscriptionConnect
          provider={provider}
          replacing={Boolean(subscription)}
          onDone={() => setConnecting(false)}
          onCancel={() => setConnecting(false)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${name}?`}
        description={
          runs
            ? `Threads run on OpenComputer credits (${agent.managedModel}) until you connect one again.`
            : `${name} stays off until you connect it again.`
        }
        confirmLabel="Disconnect"
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate(provider)}
      />
    </section>
  )
}

/**
 * Step 1's done row action: the same three ways to go as step 1, in a
 * dialog that closes once the server has the change.
 */
export function AgentChangeAction({ agent }: { agent: ComputerAgent }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<AgentCardChoice>(
    agent.choice === 'codex' ? 'codex' : 'claude',
  )
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Change
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your coding agent</DialogTitle>
            <DialogDescription>Now on {agentSummary(agent)}.</DialogDescription>
          </DialogHeader>
          <div className="text-muted-foreground space-y-4 text-sm">
            <AgentSetup
              agent={agent}
              selected={selected}
              onSelect={setSelected}
              onDone={() => setOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * The Your agent line on the page once setup is done: what runs threads, and
 * where to change it. Subscriptions are managed on Connections, one place
 * for every account (work 083).
 */
export function AgentCard({ status }: { status: ComputerStatus }) {
  const { agent } = status
  if (!agent) return null
  const needsLink = status.slack.installed && !agent.linked
  return (
    <section aria-labelledby="computer-agent">
      <h2 id="computer-agent" className="mb-3 text-sm font-semibold">
        Your agent
      </h2>
      <div className="bg-panel flex flex-wrap items-center justify-between gap-3 rounded-lg border px-5 py-3 text-sm">
        <div className="min-w-0">
          <p className="text-foreground font-medium">{agentSummary(agent)}</p>
          {needsLink ? (
            <p className="text-muted-foreground">
              Link your Slack account to use your own subscription.
            </p>
          ) : null}
        </div>
        <Button variant={needsLink ? 'default' : 'outline'} size="sm" asChild>
          <Link to="/managed-agents/connections">
            {needsLink ? 'Link Slack' : 'Manage'}
          </Link>
        </Button>
      </div>
    </section>
  )
}
