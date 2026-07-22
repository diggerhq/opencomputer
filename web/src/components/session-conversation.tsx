import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Hourglass } from 'lucide-react'
import type { SessionEvent } from '@/api/client'
import { Button } from '@/components/ui/button'
import {
  bodyText,
  httpRequestPayloadText,
  isOutOfCredits,
  isTerminalSessionStatus,
  isTurnInput,
  type GroupedTimeline,
  type TurnState,
} from '@/lib/session-turns'

export function HttpRequestCard({
  event,
  seq,
  meta,
}: {
  event: SessionEvent
  seq?: number
  meta?: ReactNode
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-foreground text-xs font-semibold">
          {event.actor?.display ?? 'HTTP'}
        </span>
        {seq != null ? (
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            #{seq}
          </span>
        ) : null}
        <span className="text-muted-foreground bg-muted rounded-sm px-1.5 py-0.5 text-[10px] font-medium">
          HTTP input
        </span>
        {meta}
      </div>
      <pre className="bg-panel-2 text-foreground/90 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {httpRequestPayloadText(event) ?? 'Payload unavailable'}
      </pre>
    </div>
  )
}

// A single chat bubble (You / Agent). Shared between the grouped Conversation
// view and the flat All log so both render identical message markup.
export function MessageBubble({
  label,
  text,
  seq,
  meta,
  outOfCredits,
}: {
  label: string
  text: string | null
  seq?: number // shown as #seq in the All log; omitted in the chat view
  meta?: ReactNode // trailing tag next to the header (e.g. queued chip)
  outOfCredits?: boolean
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-foreground text-xs font-semibold">{label}</span>
        {seq != null ? (
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            #{seq}
          </span>
        ) : null}
        {meta}
      </div>
      <p className="text-foreground/90 text-sm whitespace-pre-wrap">{text}</p>
      {outOfCredits ? (
        <Button asChild size="sm" className="mt-2">
          <Link to="/billing">Top up</Link>
        </Button>
      ) : null}
    </div>
  )
}

function TurnStateChip({
  state,
}: {
  state: Extract<TurnState, 'queued' | 'running'>
}) {
  return (
    <span className="text-muted-foreground bg-muted inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium">
      {state === 'queued' ? (
        <Hourglass className="size-2.5" aria-hidden="true" />
      ) : (
        <span
          className="bg-status-running size-1.5 rounded-full"
          aria-hidden="true"
        />
      )}
      {state === 'queued' ? 'Queued' : 'Working'}
    </span>
  )
}

// A static operational state, not a theatrical typing animation. It appears
// only after the durable turn.started boundary and disappears on completion.
function ReplyIndicator() {
  return (
    <div
      className="flex items-center gap-2 pt-1"
      role="status"
      aria-live="polite"
    >
      <span className="text-foreground/70 text-xs font-semibold">Agent</span>
      <TurnStateChip state="running" />
    </div>
  )
}

// Grouped chat view: one block per turn (its inputs as "You", its agent.message
// outputs as "Agent"), an error affordance on failure, and one static working
// state while the agent still owes a response. Lifecycle
// chrome (turn.started/turn.completed/agent.result/tool.call) is hidden here.
// Queued input — typed while a turn was running and not yet claimed by a
// follow-up turn — trails the groups.
export function TurnConversation({
  grouped,
  halted = false,
  sessionStatus,
}: {
  grouped: GroupedTimeline
  halted?: boolean
  sessionStatus?: string
}) {
  const sessionTerminal = isTerminalSessionStatus(sessionStatus)

  return (
    <ul className="divide-y">
      {grouped.groups.map((group) => {
        const errorEv = group.events.find((e) => e.type.startsWith('error'))
        const groupInputs = group.events.filter(isTurnInput)
        const activeInputId = groupInputs[groupInputs.length - 1]?.id
        const runningNoAnswer =
          group.state === 'running' &&
          !group.events.some((event) => event.type === 'agent.message')
        const showActiveState = !halted && !sessionTerminal
        return (
          <li key={group.turnId} className="space-y-3 px-4 py-3">
            {group.events.map((ev) => {
              if (ev.type === 'http.request') {
                return (
                  <HttpRequestCard
                    key={ev.id}
                    event={ev}
                    meta={
                      showActiveState &&
                      ev.id === activeInputId &&
                      group.state === 'queued' ? (
                        <TurnStateChip state="queued" />
                      ) : undefined
                    }
                  />
                )
              }
              if (ev.type === 'user.message') {
                return (
                  <MessageBubble
                    key={ev.id}
                    label={ev.actor?.display ?? 'You'}
                    text={bodyText(ev)}
                    meta={
                      showActiveState &&
                      ev.id === activeInputId &&
                      group.state === 'queued' ? (
                        <TurnStateChip state="queued" />
                      ) : undefined
                    }
                  />
                )
              }
              if (ev.type === 'agent.message') {
                return (
                  <MessageBubble
                    key={ev.id}
                    label={ev.actor?.display ?? 'Agent'}
                    text={bodyText(ev)}
                    outOfCredits={isOutOfCredits(ev)}
                  />
                )
              }
              return null // hide agent.result / tool.call / error chrome
            })}
            {showActiveState && runningNoAnswer ? <ReplyIndicator /> : null}
            {group.state === 'error' ? (
              <div className="bg-status-error-bg/40 text-status-error rounded-sm px-3 py-2 text-xs">
                {group.errorMessage ??
                  (errorEv && bodyText(errorEv)) ??
                  'The agent hit an error on this turn.'}
              </div>
            ) : null}
          </li>
        )
      })}
      {grouped.pending.map((ev) => (
        <li key={ev.id} className="px-4 py-3">
          {ev.type === 'http.request' ? (
            <HttpRequestCard
              event={ev}
              meta={
                !halted && !sessionTerminal ? (
                  <TurnStateChip state="queued" />
                ) : undefined
              }
            />
          ) : (
            <MessageBubble
              label={ev.actor?.display ?? 'You'}
              text={bodyText(ev)}
              meta={
                !halted && !sessionTerminal ? (
                  <TurnStateChip state="queued" />
                ) : undefined
              }
            />
          )}
        </li>
      ))}
    </ul>
  )
}
