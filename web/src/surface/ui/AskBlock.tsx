import { useState } from 'react'
import type { Answer, Ask } from '@opencomputer/sdk/computer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useSurface } from '../hooks'
import { Rich } from './bits'
import { ACTS, BLOCK } from './kit'
import { SecretForm } from './SecretForm'

// An ask in the conversation: its buttons while it waits on the person, what
// was said once it has closed (R33).

const ASIDE = 'text-muted-foreground text-[12.5px]'
// An ask still waiting on the person; one that is closed goes quiet.
const askCls = (open: boolean) =>
  cn(
    BLOCK,
    open ? 'bg-status-pending-bg border-status-pending/25' : 'opacity-70',
  )

type Question = {
  id: string
  text: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

const questionsOf = (ask: Ask): Question[] => {
  const qs = (ask.question?.questions ?? []) as Partial<Question>[]
  return qs.map((q, i) => ({
    id: q.id ?? String(i),
    text: q.text ?? '',
    options: q.options ?? [],
    multiSelect: q.multiSelect,
  }))
}

// Leaving plan mode is asked as an approval of the plan.
const isPlan = (ask: Ask) => ask.approval?.toolName === 'ExitPlanMode'

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

// What a closed ask shows in place of its buttons.
function answered(ask: Ask): string {
  if (ask.status !== 'answered')
    return ask.status === 'interrupted'
      ? 'Stopped before it was answered'
      : 'Dismissed'
  const a = (ask.answer ?? {}) as {
    decision?: string
    answers?: { choices?: string[]; text?: string | null }[]
  }
  if (a.decision)
    return a.decision === 'deny'
      ? 'Not allowed'
      : a.decision === 'always'
        ? isPlan(ask)
          ? 'Allowed, accepting edits'
          : 'Always allowed'
        : 'Allowed'
  const said = (a.answers ?? []).flatMap((x) => [
    ...(x.choices ?? []),
    ...(x.text ? [x.text] : []),
  ])
  return said.length ? said.join(' · ') : 'Answered'
}

export function AskBlock({ ask }: { ask: Ask }) {
  const open = ask.status === 'open'
  const closed = open ? null : (
    <div className={cn(ASIDE, 'mt-2')}>{answered(ask)}</div>
  )
  return (
    <div className={askCls(open)}>
      {ask.kind === 'approval' ? (
        <Approval ask={ask} />
      ) : ask.kind === 'question' ? (
        <Questions ask={ask} />
      ) : (
        <SecretForm ask={ask} />
      )}
      {closed}
    </div>
  )
}

function Approval({ ask }: { ask: Ask }) {
  const surface = useSurface()
  const a = ask.approval ?? {}
  const title = str(a.title) ?? str(a.toolName)
  const command = str(a.command)
  const plan = isPlan(ask)
    ? str((a.input as { plan?: unknown } | undefined)?.plan)
    : null
  const always = plan ? null : str(a.alwaysAllows)
  const decide = (decision: 'allow' | 'deny' | 'always') =>
    surface.answer(ask.sessionId, ask.id, { decision })
  return (
    <>
      {plan ? (
        <Rich text={plan} />
      ) : (
        <>
          <Rich text={command && title ? title : 'Needs your OK'} />
          {(command ?? title) && (
            <pre className="bg-card mt-2 overflow-auto rounded-md border px-3 py-2 font-mono text-xs">
              {command ?? title}
            </pre>
          )}
        </>
      )}
      {ask.status === 'open' && (
        <div className={ACTS}>
          <Button size="sm" onClick={() => decide('allow')}>
            Allow
          </Button>
          {isPlan(ask) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => decide('always')}
            >
              Approve, accept edits
            </Button>
          )}
          {always && (
            <Button
              size="sm"
              variant="outline"
              title={`Allows ${always} without asking again in this session`}
              onClick={() => decide('always')}
            >
              Always allow for this session
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => decide('deny')}>
            Don't allow
          </Button>
        </div>
      )}
    </>
  )
}

function Questions({ ask }: { ask: Ask }) {
  const surface = useSurface()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})
  const open = ask.status === 'open'
  const qs = questionsOf(ask)
  // One question with one choice is answered by the click itself.
  const direct = qs.length === 1 && !qs[0].multiSelect
  const send = (choices: Record<string, string[]>) =>
    surface.answer(ask.sessionId, ask.id, {
      answers: qs.map((q) => ({
        questionId: q.id,
        choices: choices[q.id] ?? [],
        text: typed[q.id]?.trim() || null,
      })),
    } satisfies Answer)
  const pick = (q: Question, label: string) => {
    if (direct) return send({ [q.id]: [label] })
    const have = picked[q.id] ?? []
    const next = q.multiSelect
      ? have.includes(label)
        ? have.filter((l) => l !== label)
        : [...have, label]
      : [label]
    setPicked({ ...picked, [q.id]: next })
  }
  const said = (q: Question) =>
    (picked[q.id] ?? []).length > 0 || !!typed[q.id]?.trim()
  const anyTyped = qs.some((q) => typed[q.id]?.trim())
  return (
    <>
      {qs.map((q, i) => (
        <div key={q.id} className={i ? 'mt-3' : undefined}>
          <Rich text={q.text} />
          {open && (
            <>
              <div className={ACTS}>
                {q.options.map((o) => (
                  <Button
                    key={o.label}
                    size="sm"
                    variant={
                      (picked[q.id] ?? []).includes(o.label)
                        ? 'default'
                        : 'outline'
                    }
                    title={o.description}
                    onClick={() => pick(q, o.label)}
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
              <Input
                aria-label={`Answer: ${q.text}`}
                placeholder="Or type an answer"
                className="bg-card mt-2 h-8"
                value={typed[q.id] ?? ''}
                onChange={(e) => setTyped({ ...typed, [q.id]: e.target.value })}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.nativeEvent.isComposing &&
                    qs.every(said)
                  )
                    send(picked)
                }}
              />
            </>
          )}
        </div>
      ))}
      {open && (!direct || anyTyped) && (
        <div className={ACTS}>
          <Button
            size="sm"
            disabled={!qs.every(said)}
            onClick={() => send(picked)}
          >
            Send
          </Button>
        </div>
      )}
    </>
  )
}
