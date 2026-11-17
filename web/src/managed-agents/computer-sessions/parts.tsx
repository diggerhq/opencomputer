import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, KeyRound, Terminal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/form'
import { SlackMark } from '@/components/slack-mark'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  answerAsk,
  dismissAsk,
  sessionKeys,
  type Ask,
  type AskAnswer,
  type Session,
  type SessionSettings,
} from '../computer-sessions-api'
import { askTitle, isBusy, sessionTitle, useCapabilities } from './state'

export function StatusDot({
  status,
  className,
}: {
  status: string
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        status === 'waiting' && 'bg-amber-500',
        isBusy(status) && 'bg-status-running animate-pulse',
        status === 'idle' && 'bg-muted-foreground/40',
        status === 'suspended' && 'bg-muted-foreground/20',
        className,
      )}
    />
  )
}

export function OriginMark({
  origin,
  className,
}: {
  origin: Session['origin']
  className?: string
}) {
  if (origin.type === 'slack')
    return <SlackMark className={cn('size-3', className)} />
  if (origin.type === 'opc' || origin.type === 'api')
    return <Terminal className={cn('size-3', className)} aria-hidden />
  return null
}

// Model and permission mode, from the computer's capabilities.
export function SettingsPickers({
  value,
  onChange,
  disabled,
}: {
  value: SessionSettings
  onChange: (next: SessionSettings) => void
  disabled?: boolean
}) {
  const { data: caps } = useCapabilities()
  if (!caps) return null
  const model =
    caps.models.find((m) => m.id === value.model) ??
    caps.models.find((m) => m.default) ??
    caps.models[0]
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {caps.models.length > 1 ? (
        <Select
          value={model?.id ?? ''}
          onValueChange={(m) => onChange({ ...value, model: m })}
          options={caps.models.map((m) => ({ value: m.id, label: m.name }))}
          disabled={disabled}
          className="text-muted-foreground hover:border-border h-7 w-auto border-transparent px-2 text-xs"
        />
      ) : null}
      {model && model.efforts.length > 1 ? (
        <Select
          value={value.effort ?? ''}
          placeholder="Effort"
          onValueChange={(e) => onChange({ ...value, effort: e })}
          options={model.efforts.map((e) => ({ value: e, label: e }))}
          disabled={disabled}
          className="text-muted-foreground hover:border-border h-7 w-auto border-transparent px-2 text-xs capitalize"
        />
      ) : null}
      {caps.modes.length > 1 ? (
        <Select
          // A session asked for no mode runs with full access, as from Slack.
          value={value.mode ?? 'bypassPermissions'}
          onValueChange={(m) => onChange({ ...value, mode: m })}
          options={caps.modes.map((m) => ({ value: m, label: modeLabel(m) }))}
          disabled={disabled}
          className="text-muted-foreground hover:border-border h-7 w-auto border-transparent px-2 text-xs"
        />
      ) : null}
    </div>
  )
}

function modeLabel(mode: string) {
  switch (mode) {
    case 'default':
      return 'Ask before edits'
    case 'acceptEdits':
      return 'Accept edits'
    case 'plan':
      return 'Plan'
    case 'bypassPermissions':
      return 'Full access'
    default:
      return mode
  }
}

function preview(input: unknown): string | null {
  if (input === undefined || input === null) return null
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>
    for (const k of ['command', 'file_path', 'path', 'url', 'query']) {
      if (typeof o[k] === 'string') return o[k]
    }
  }
  const s = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  return s.length > 600 ? `${s.slice(0, 600)}…` : s
}

// An open ask, answerable here: approve or deny a tool call, or answer the
// agent's questions. A secret is set privately, so it points to Secrets.
export function AskCard({
  ask,
  session,
  showSession,
}: {
  ask: Ask
  session?: Session
  showSession?: boolean
}) {
  const qc = useQueryClient()
  const answer = useMutation({
    mutationFn: (a: AskAnswer) => answerAsk(ask.sessionId, ask.id, a),
    onSuccess: () => void qc.invalidateQueries({ queryKey: sessionKeys.all }),
    onError: (e) => notifyError('Could not answer', e),
  })
  const dismiss = useMutation({
    mutationFn: () => dismissAsk(ask.sessionId, ask.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: sessionKeys.all }),
    onError: (e) => notifyError('Could not dismiss', e),
  })
  const busy = answer.isPending || dismiss.isPending

  return (
    <div className="bg-card rounded-lg border border-amber-500/40 p-3 shadow-xs">
      {showSession && session ? (
        <Link
          to={`/computer/sessions/${session.id}`}
          className="text-muted-foreground hover:text-foreground mb-1.5 flex items-center gap-1.5 text-xs"
        >
          <StatusDot status="waiting" />
          <span className="truncate">{sessionTitle(session)}</span>
        </Link>
      ) : null}
      {ask.kind === 'approval' ? (
        <ApprovalBody
          ask={ask}
          busy={busy}
          onAnswer={(a) => answer.mutate(a)}
        />
      ) : ask.kind === 'question' ? (
        <QuestionBody
          ask={ask}
          busy={busy}
          onAnswer={(a) => answer.mutate(a)}
          onDismiss={() => dismiss.mutate()}
        />
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm">
            <KeyRound className="size-4 opacity-60" aria-hidden />
            {askTitle(ask)}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to="/computer/secrets">Open Secrets</Link>
          </Button>
        </div>
      )}
    </div>
  )
}

function ApprovalBody({
  ask,
  busy,
  onAnswer,
}: {
  ask: Ask
  busy: boolean
  onAnswer: (a: AskAnswer) => void
}) {
  const detail = preview(ask.approval?.input)
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{askTitle(ask)}</p>
      {detail ? (
        <pre className="bg-muted text-muted-foreground max-h-40 overflow-auto rounded-md px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap">
          {detail}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onAnswer({ decision: 'allow' })}
        >
          <Check aria-hidden />
          Allow
        </Button>
        {ask.approval?.alwaysAllows ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title={ask.approval.alwaysAllows}
            onClick={() => onAnswer({ decision: 'always' })}
          >
            Always allow
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onAnswer({ decision: 'deny' })}
        >
          <X aria-hidden />
          Deny
        </Button>
      </div>
    </div>
  )
}

function QuestionBody({
  ask,
  busy,
  onAnswer,
  onDismiss,
}: {
  ask: Ask
  busy: boolean
  onAnswer: (a: AskAnswer) => void
  onDismiss: () => void
}) {
  const questions = ask.question?.questions ?? []
  const [choices, setChoices] = useState<Record<string, string[]>>({})
  const [texts, setTexts] = useState<Record<string, string>>({})
  const toggle = (qid: string, label: string, multi: boolean) =>
    setChoices((c) => {
      const have = c[qid] ?? []
      const next = have.includes(label)
        ? have.filter((l) => l !== label)
        : multi
          ? [...have, label]
          : [label]
      return { ...c, [qid]: next }
    })
  const complete = questions.every(
    (q) => (choices[q.id]?.length ?? 0) > 0 || (texts[q.id] ?? '').trim(),
  )

  return (
    <div className="space-y-3">
      {questions.map((q) => (
        <div key={q.id} className="space-y-1.5">
          <p className="text-sm font-medium">{q.text || q.header}</p>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((o) => {
              const on = choices[q.id]?.includes(o.label)
              return (
                <button
                  key={o.label}
                  type="button"
                  title={o.description ?? undefined}
                  onClick={() => toggle(q.id, o.label, q.multiSelect)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs transition-colors',
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'hover:bg-muted',
                  )}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          <input
            value={texts[q.id] ?? ''}
            onChange={(e) =>
              setTexts((t) => ({ ...t, [q.id]: e.target.value }))
            }
            placeholder="Or type an answer"
            className="border-input w-full rounded-md border bg-transparent px-2.5 py-1 text-xs outline-none"
          />
        </div>
      ))}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          disabled={busy || !complete}
          onClick={() =>
            onAnswer({
              answers: questions.map((q) => ({
                questionId: q.id,
                choices: choices[q.id] ?? [],
                text: (texts[q.id] ?? '').trim() || null,
              })),
            })
          }
        >
          Answer
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
          Skip
        </Button>
      </div>
    </div>
  )
}
