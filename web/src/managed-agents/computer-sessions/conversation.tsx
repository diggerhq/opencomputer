import { useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  User,
  X,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AgentMarkdown } from '../AgentMarkdown'
import { OpenComputerMark } from './parts'
import { askTitle } from './state'
import { formatDuration, type TranscriptItem } from './transcript'

// A transcript's items as the session view draws them; triage shows an
// excerpt of the same.

/** Where a message came from, beside its author's name; the web's own messages say nothing. */
const VIA: Record<string, string> = { slack: 'Slack', opc: 'CLI', api: 'API' }

// A person's avatar: initials of their name, or the first letter of their email.
function initials(author: string): string {
  if (author.includes('@')) return author[0].toUpperCase()
  const words = author.trim().split(/\s+/)
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

export function Item({
  item,
  leads,
  emails,
}: {
  item: TranscriptItem
  leads: boolean
  emails: Map<string, string> | undefined
}) {
  switch (item.kind) {
    case 'user': {
      const email = item.authorId ? emails?.get(item.authorId) : undefined
      return (
        <div className="flex items-end justify-end gap-2">
          <div className="flex max-w-[85%] flex-col items-end gap-1">
            {item.author || email ? (
              <span className="text-muted-foreground text-xs">
                {item.author ?? email}
                {item.via && VIA[item.via] ? ` · ${VIA[item.via]}` : ''}
              </span>
            ) : null}
            <div className="bg-secondary rounded-2xl rounded-br-md px-3.5 py-2 text-sm whitespace-pre-wrap">
              {item.text}
            </div>
          </div>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium">
                  {item.author || email ? (
                    initials(item.author ?? email ?? '')
                  ) : (
                    <User className="size-3.5" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left">
                {item.author ?? email ?? 'Someone'}
                {email && item.author && email !== item.author ? (
                  <span className="block opacity-70">{email}</span>
                ) : null}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )
    }
    case 'agent':
      return (
        <div className="space-y-2">
          {leads ? <AgentByline /> : null}
          <AgentMarkdown>{item.text}</AgentMarkdown>
        </div>
      )
    case 'work':
      return (
        <div className="space-y-2">
          {leads ? <AgentByline /> : null}
          <WorkStep item={item} />
        </div>
      )
    case 'ask':
      // Open asks are answered at the end of the transcript.
      if (item.ask.status === 'open') return null
      return (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {item.ask.status === 'answered' ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <X className="size-3.5" aria-hidden />
          )}
          {askTitle(item.ask)} · {item.ask.status}
        </p>
      )
    case 'note':
      return (
        <p
          className={cn(
            'flex items-center gap-1.5 text-xs',
            item.tone === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {item.tone === 'error' ? (
            <CircleAlert className="size-3.5" aria-hidden />
          ) : null}
          {item.text}
        </p>
      )
  }
}

function WorkStep({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'work' }>
}) {
  const [open, setOpen] = useState(false)
  const ms =
    new Date(item.endedAt).getTime() - new Date(item.startedAt).getTime()
  const failed = item.tools.filter((t) => t.status === 'failed').length
  const label = item.open
    ? `Working · ${item.tools.length} ${item.tools.length === 1 ? 'step' : 'steps'}`
    : `Worked for ${formatDuration(ms)}`
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        {label}
        {failed ? (
          <span className="text-destructive">· {failed} failed</span>
        ) : null}
      </button>
      {open && item.tools.length ? (
        <ul className="border-border mt-1.5 ml-1.5 space-y-0.5 border-l pl-3">
          {item.tools.map((t) => (
            <li
              key={t.callId}
              className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs"
            >
              {t.status === 'running' ? (
                <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
              ) : t.status === 'failed' ? (
                <X className="text-destructive size-3 shrink-0" aria-hidden />
              ) : (
                <Check className="size-3 shrink-0 opacity-60" aria-hidden />
              )}
              <span className="truncate">{t.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function AgentByline() {
  return (
    <div className="flex items-center gap-2 text-xs font-medium">
      <OpenComputerMark className="size-6" />
      Computer
    </div>
  )
}
