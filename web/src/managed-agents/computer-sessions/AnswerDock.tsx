import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  KeyRound,
  Loader2,
} from 'lucide-react'
import { ChatTextarea } from '@/components/chat-textarea'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  answerAsk,
  bringBack,
  sendTurn,
  sessionKeys,
  setAside,
  type Ask,
  type AskAnswer,
} from '../computer-sessions-api'
import { ApprovalDetail } from './ask-detail'
import { isPlan } from './ask-line'
import { useCapabilities } from './state'
import type { TriageEntry } from './triage'

// The answer dock (TRIAGE_WEB_NOTES.md): one card at the bottom of the ask,
// shaped by it. What the agent asked for is attached on top, the text box is
// the one place to type, and the footer holds the verdict. Typing is always
// the free-form answer: on an approval it declines the call and tells the
// agent what to do instead, on a question it is the answer in the person's
// words, otherwise it is the reply.

type Action =
  | { type: 'text'; text: string }
  | { type: 'answer'; answer: AskAnswer; said: string }

type Question = NonNullable<Ask['question']>['questions'][number]

export function AnswerDock({
  entry,
  gone,
  draft,
  setDraft,
  onAnswered,
  onAside,
  onBack,
  onNext,
}: {
  entry: TriageEntry
  /** Answered somewhere else while on screen: the box sends plain messages. */
  gone: boolean
  draft: string
  setDraft: (text: string) => void
  /** Accepted; `said` is the one-line confirmation of what was sent. */
  onAnswered: (said: string) => void
  onAside: () => Promise<void>
  onBack: () => void
  onNext: () => void
}) {
  const { session: s, ask, kind } = entry
  const qc = useQueryClient()
  const { data: caps } = useCapabilities()
  const questions = ask?.question?.questions ?? []
  // One question with one answer: a click on an option is the answer.
  const oneClick = questions.length === 1 && !questions[0].multiSelect
  const [chosen, setChosen] = useState<Record<string, string[]>>({})
  const text = draft.trim()

  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.querySelector('textarea')?.focus(), [])

  const act = useMutation({
    mutationFn: async (a: Action) => {
      if (a.type === 'answer') return answerAsk(s.id, ask!.id, a.answer)
      // A question in the person's own words is its answer; anything else
      // typed is a message. Steering closes the open asks with it ("Open asks
      // close as declined; the message is the answer"); once the ask is
      // gone it goes as an ordinary message.
      if (!gone && kind === 'question' && questions.length === 1)
        return answerAsk(s.id, ask!.id, {
          answers: [{ questionId: questions[0].id, choices: [], text: a.text }],
        })
      return sendTurn(
        s.id,
        a.text,
        !gone && caps?.features.steer !== false ? 'steer' : 'queue',
      )
    },
    onSuccess: (_, a) => {
      void qc.invalidateQueries({ queryKey: sessionKeys.all })
      if (gone) return setDraft('')
      onAnswered(a.type === 'answer' ? a.said : sentLine(kind))
    },
  })
  const aside = useMutation({
    mutationFn: () =>
      entry.aside ? bringBack(s.id) : setAside(s.id, entry.ref),
    onSuccess: () => (entry.aside ? onBack() : onAside()),
    onError: (e) =>
      notifyError(
        entry.aside ? 'Could not bring it back' : 'Could not set it aside',
        e,
      ),
  })
  const busy = act.isPending

  const decide = (decision: 'allow' | 'deny' | 'always', said: string) =>
    act.mutate({ type: 'answer', answer: { decision }, said })
  // Every question answered by its choices; typed text goes with the last.
  const answerChoices = (picked: Record<string, string[]>) =>
    act.mutate({
      type: 'answer',
      said: `Answered: ${questions.flatMap((q) => picked[q.id] ?? []).join(', ')}`,
      answer: {
        answers: questions.map((q, i) => ({
          questionId: q.id,
          choices: picked[q.id] ?? [],
          text: i === questions.length - 1 && text ? text : null,
        })),
      },
    })
  const picked = questions.some((q) => chosen[q.id]?.length)
  const allPicked =
    questions.length > 0 && questions.every((q) => chosen[q.id]?.length)
  const submit = () => {
    if (busy) return
    if (kind === 'question' && !gone && picked) {
      if (allPicked) answerChoices(chosen)
      return
    }
    if (text) act.mutate({ type: 'text', text })
  }
  const retry = () => act.variables && act.mutate(act.variables)

  const verdict = kind === 'approval' && !gone && !text
  const canSend =
    !busy && (kind === 'question' && !gone && picked ? allPicked : !!text)

  return (
    <div
      ref={box}
      className="bg-card focus-within:border-ring/50 rounded-xl border shadow-sm transition-colors"
    >
      {gone ? (
        <Attached>
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              This was answered elsewhere.
            </p>
            <Button size="sm" variant="outline" onClick={onNext}>
              Next
            </Button>
          </div>
        </Attached>
      ) : kind === 'approval' && ask ? (
        <Attached>
          <ApprovalDetail ask={ask} />
        </Attached>
      ) : kind === 'question' && questions.length ? (
        <Attached>
          <div className="space-y-3">
            {questions.map((q) => (
              <Options
                key={q.id}
                question={q}
                // One question is the headline already.
                titled={questions.length > 1}
                chosen={chosen[q.id] ?? []}
                disabled={busy}
                onPick={(label) => {
                  if (oneClick) return answerChoices({ [q.id]: [label] })
                  setChosen((c) => {
                    const have = c[q.id] ?? []
                    const next = have.includes(label)
                      ? have.filter((l) => l !== label)
                      : q.multiSelect
                        ? [...have, label]
                        : [label]
                    return { ...c, [q.id]: next }
                  })
                }}
              />
            ))}
          </div>
        </Attached>
      ) : kind === 'secret' && ask ? (
        <Attached>
          <SecretRequest ask={ask} />
        </Attached>
      ) : null}

      <ChatTextarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onSend={submit}
        placeholder={placeholder(gone ? 'gone' : kind, ask)}
        aria-label="Reply"
        className="min-h-11 resize-none border-0 bg-transparent px-4 pt-3 pb-1 leading-5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      <div className="flex items-center gap-2 px-2 pb-2">
        {gone ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={aside.isPending}
            onClick={() => aside.mutate()}
          >
            {entry.aside ? 'Bring back' : 'Set aside'}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {act.isError ? (
            <p
              role="alert"
              className="text-destructive flex items-center gap-1.5 text-xs"
            >
              Not sent
              <span aria-hidden>·</span>
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={retry}
              >
                Retry
              </button>
            </p>
          ) : null}
          {verdict ? (
            <Verdict ask={ask!} busy={busy} decide={decide} />
          ) : (
            <>
              {kind === 'approval' && !gone ? (
                <span className="text-muted-foreground text-xs">
                  Declines, and sends this instead
                </span>
              ) : null}
              <Button
                size="icon"
                className="rounded-full"
                aria-label="Send"
                disabled={!canSend}
                onClick={submit}
              >
                {busy ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <ArrowUp aria-hidden />
                )}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Attached({ children }: { children: ReactNode }) {
  return <div className="border-b p-3">{children}</div>
}

function sentLine(kind: TriageEntry['kind']) {
  return kind === 'approval' || kind === 'secret'
    ? 'Declined with your message'
    : 'Reply sent'
}

function placeholder(kind: TriageEntry['kind'] | 'gone', ask: Ask | null) {
  switch (kind) {
    case 'gone':
      return 'Message the agent'
    case 'approval':
      return ask && isPlan(ask)
        ? 'Or say what to change in the plan'
        : 'Or tell it what to do instead'
    case 'question':
      return 'Or answer in your own words'
    case 'secret':
      return 'Or reply instead'
    default:
      return 'Reply'
  }
}

// The approval's own buttons, as in Slack: Deny, Allow for this session when
// the call can be remembered, Allow. A plan has its own three.
function Verdict({
  ask,
  busy,
  decide,
}: {
  ask: Ask
  busy: boolean
  decide: (d: 'allow' | 'deny' | 'always', said: string) => void
}) {
  if (isPlan(ask))
    return (
      <>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => decide('deny', 'Kept planning')}
        >
          Keep planning
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => decide('allow', 'Plan approved, asking before edits')}
        >
          Approve, ask before edits
        </Button>
        <Button
          disabled={busy}
          onClick={() => decide('always', 'Plan approved, accepting edits')}
        >
          Approve, accept edits
        </Button>
      </>
    )
  const always = ask.approval?.alwaysAllows
  return (
    <>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => decide('deny', 'Denied')}
      >
        Deny
      </Button>
      {always ? (
        <Button
          variant="outline"
          disabled={busy}
          title={`Allows ${always} without asking again in this session`}
          onClick={() => decide('always', `Allowed ${always} for the session`)}
        >
          Allow for this session
        </Button>
      ) : null}
      <Button disabled={busy} onClick={() => decide('allow', 'Allowed')}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
        Allow
      </Button>
    </>
  )
}

function Options({
  question,
  titled,
  chosen,
  disabled,
  onPick,
}: {
  question: Question
  titled: boolean
  chosen: string[]
  disabled: boolean
  onPick: (label: string) => void
}) {
  const box = question.multiSelect
  return (
    <fieldset className="space-y-2">
      {titled || box ? (
        <legend className="text-muted-foreground mb-2 flex gap-2 text-xs">
          {titled ? (
            <span className="text-foreground font-medium">
              {question.text || question.header}
            </span>
          ) : null}
          {box ? <span>Choose any</span> : null}
        </legend>
      ) : null}
      <div className="divide-y overflow-hidden rounded-lg border">
        {question.options.map((o) => {
          const on = chosen.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              disabled={disabled}
              aria-pressed={box || !titled ? on : undefined}
              onClick={() => onPick(o.label)}
              className={cn(
                'group/opt hover:bg-muted/60 flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors disabled:opacity-60',
                on && 'bg-muted',
              )}
            >
              {box || titled ? (
                <span
                  aria-hidden
                  className={cn(
                    'border-input mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                    box ? 'rounded-[3px]' : 'rounded-full',
                    on && 'border-primary bg-primary text-primary-foreground',
                  )}
                >
                  {on ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{o.label}</span>
                {o.description ? (
                  <span className="text-muted-foreground">
                    {' '}
                    · {o.description}
                  </span>
                ) : null}
              </span>
              {box || titled ? null : (
                <ArrowRight
                  aria-hidden
                  className="text-muted-foreground mt-0.5 size-4 shrink-0 opacity-0 transition-opacity group-hover/opt:opacity-100 group-focus-visible/opt:opacity-100"
                />
              )}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

// A secret is set privately, in Secrets; the agent goes on once it is. A
// masked field can take the button's place here when the API takes values.
function SecretRequest({ ask }: { ask: Ask }) {
  const req = (ask.secret ?? {}) as {
    name?: string
    purpose?: string
    file?: boolean
  }
  return (
    <div className="flex items-start gap-3">
      <KeyRound
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex items-baseline gap-2 text-sm">
          <span className="font-mono font-medium break-all">
            {req.name ?? 'A secret'}
          </span>
          {req.file ? (
            <span className="text-muted-foreground text-xs">file</span>
          ) : null}
        </p>
        {req.purpose ? (
          <p className="text-muted-foreground text-sm">{req.purpose}</p>
        ) : null}
      </div>
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link to="/computer/secrets">
          Add in Secrets
          <ArrowUpRight aria-hidden />
        </Link>
      </Button>
    </div>
  )
}
