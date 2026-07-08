import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Hourglass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  bodyText,
  isOutOfCredits,
  type GroupedTimeline,
} from '@/lib/session-turns'

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

// "A reply is coming" — a gentle agent-side typing indicator. Three dots pulse
// in sequence; no failure is implied. Shown while a turn is running with no
// answer yet, OR while input sits queued waiting for its follow-up turn to
// dispatch (the ~gap the user otherwise reads as "stuck").
function ReplyIndicator() {
  return (
    <li className="px-4 py-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-foreground/70 text-xs font-semibold">Agent</span>
      </div>
      <span
        className="flex items-center gap-1"
        role="status"
        aria-label="Agent is responding"
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="bg-muted-foreground/50 size-1.5 animate-pulse rounded-full"
            style={{ animationDelay: `${i * 200}ms`, animationDuration: '1s' }}
          />
        ))}
      </span>
    </li>
  )
}

// Grouped chat view: one block per turn (its inputs as "You", its agent.message
// outputs as "Agent"), an error affordance on failure, and a single trailing
// "reply coming" indicator while the agent still owes a response. Lifecycle
// chrome (turn.started/turn.completed/agent.result/tool.call) is hidden here.
// Queued input — typed while a turn was running and not yet claimed by a
// follow-up turn — trails the groups.
export function TurnConversation({
  grouped,
  halted = false,
}: {
  grouped: GroupedTimeline
  halted?: boolean
}) {
  const last = grouped.groups[grouped.groups.length - 1]
  const runningNoAnswer =
    !!last &&
    last.state === 'running' &&
    !last.events.some((e) => e.type === 'agent.message')
  // A response is expected (no failure) when a turn is mid-flight without an
  // answer yet, or input is queued for a not-yet-dispatched turn. Suppressed
  // when halted (out of credits → nothing runs until top-up).
  const replyPending = !halted && (runningNoAnswer || grouped.pending.length > 0)

  return (
    <ul className="divide-y">
      {grouped.groups.map((group) => {
        const errorEv = group.events.find((e) => e.type.startsWith('error'))
        return (
          <li key={group.turnId} className="space-y-3 px-4 py-3">
            {group.events.map((ev) => {
              if (ev.turn_id == null) {
                return (
                  <MessageBubble
                    key={ev.id}
                    label={ev.actor?.display ?? 'You'}
                    text={bodyText(ev)}
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
            {group.state === 'error' ? (
              <div className="bg-status-error-bg/40 text-status-error rounded-sm px-3 py-2 text-xs">
                {(errorEv && bodyText(errorEv)) ??
                  'The agent hit an error on this turn.'}
              </div>
            ) : null}
          </li>
        )
      })}
      {grouped.pending.map((ev) => (
        <li key={ev.id} className="px-4 py-3">
          <MessageBubble
            label={ev.actor?.display ?? 'You'}
            text={bodyText(ev)}
            meta={
              <span className="text-muted-foreground bg-muted inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium">
                <Hourglass className="size-2.5" />
                Queued · runs next
              </span>
            }
          />
        </li>
      ))}
      {replyPending ? <ReplyIndicator /> : null}
    </ul>
  )
}
