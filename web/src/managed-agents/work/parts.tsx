import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  CloudOff,
  GitPullRequest,
  MessagesSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusDot } from '../computer-sessions/parts'
import { timeAgo } from '../computer-sessions/transcript'
import type {
  Item,
  ItemSession,
  Owner,
  Person,
  PullRequest,
  PullState,
} from './api'
import {
  attentionLabel,
  personName,
  pullLabel,
  pullStateWord,
  sessionStatusWord,
} from './board'

// Small pieces shared by the board and the item page.

export function Avatar({
  person,
  title,
  className,
}: {
  person: Person
  // The hover text; the name by default, null for none (the parent has it).
  title?: string | null
  className?: string
}) {
  const name = personName(person)
  return (
    <span
      title={title === null ? undefined : (title ?? name)}
      className={cn(
        'bg-secondary text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium uppercase',
        className,
      )}
    >
      {name.charAt(0)}
    </span>
  )
}

// Said on hover over an owner the doc does not name.
export const DERIVED_OWNER = 'From recent commits'

/**
 * The owner on a card: initial and name. One the doc does not declare, taken
 * from its recent commits, is quieter.
 */
export function OwnerMark({ owner }: { owner: Owner }) {
  const derived = owner.source === 'derived'
  const name = personName(owner)
  return (
    <span
      title={derived ? `${name} · ${DERIVED_OWNER}` : name}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5',
        derived ? 'text-muted-foreground/80' : 'text-foreground/80',
      )}
    >
      <Avatar
        person={owner}
        title={null}
        className={cn(
          derived &&
            'text-muted-foreground/80 border-muted-foreground/40 border border-dashed bg-transparent',
        )}
      />
      <span className="max-w-28 truncate">{name}</span>
      {derived ? <span className="sr-only">, {DERIVED_OWNER}</span> : null}
    </span>
  )
}

/** One dot per linked session, each a link to it; title and state on hover. */
export function SessionDots({ sessions }: { sessions: ItemSession[] }) {
  if (!sessions.length) return null
  return (
    <span className="inline-flex items-center gap-1">
      <MessagesSquare className="size-3.5" aria-hidden />
      {sessions.map((s) => {
        const label = [
          s.title || 'Untitled session',
          s.ownerName,
          sessionStatusWord(s.status),
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <Link
            key={s.id}
            to={`/computer/sessions/${s.id}`}
            title={label}
            aria-label={`Session: ${label}`}
            className="relative z-10 -m-0.5 inline-flex p-0.5 hover:opacity-70"
          >
            <StatusDot status={s.status} className="size-2" />
          </Link>
        )
      })}
    </span>
  )
}

export function Tag({
  tag,
  onClick,
  active,
}: {
  tag: string
  onClick?: () => void
  active?: boolean
}) {
  const className = cn(
    'text-muted-foreground relative z-10 inline-flex h-[18px] max-w-32 shrink-0 items-center truncate rounded-sm border px-1.5 text-[11px] leading-none',
    onClick &&
      'hover:text-foreground hover:border-foreground/25 cursor-pointer transition-colors',
    active && 'bg-foreground text-background border-foreground',
  )
  if (!onClick)
    return (
      <span className={className}>
        <span className="truncate">{tag}</span>
      </span>
    )
  return (
    <button
      type="button"
      className={className}
      title={`Show items tagged ${tag}`}
      onClick={onClick}
    >
      <span className="truncate">{tag}</span>
    </button>
  )
}

const PULL_DOT: Record<NonNullable<PullState>, string> = {
  open: 'bg-status-running',
  draft: 'bg-status-stopped',
  merged: 'bg-status-hibernated',
  closed: 'bg-status-error',
}

export function PullDot({
  state,
  className,
}: {
  state: PullState
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        state ? PULL_DOT[state] : 'border-muted-foreground/70 border',
        className,
      )}
    />
  )
}

/** One dot per pull request, each a link to GitHub; number and state on hover. */
export function PullDots({ prs }: { prs: PullRequest[] }) {
  if (!prs.length) return null
  return (
    <span className="inline-flex items-center gap-1">
      <GitPullRequest className="size-3.5" aria-hidden />
      {prs.map((pr) => {
        const label = [pullLabel(pr), pr.title, pullStateWord(pr.state)]
          .filter(Boolean)
          .join(' · ')
        return (
          <a
            key={pr.url}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title={label}
            aria-label={label}
            className="relative z-10 -m-0.5 inline-flex p-0.5 hover:opacity-70"
          >
            <PullDot state={pr.state} className="size-2" />
          </a>
        )
      })}
    </span>
  )
}

/** The one attention line: only "needs you" is coloured. */
export function AttentionMark({
  item,
  className,
}: {
  item: Item
  className?: string
}) {
  const label = attentionLabel(item, (iso) => timeAgo(iso))
  if (!label) return null
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-xs',
        label.needsYou
          ? 'font-medium text-amber-700 dark:text-amber-400'
          : 'text-muted-foreground',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-1.5 shrink-0 rounded-full',
          label.needsYou
            ? 'bg-amber-500'
            : item.attention?.state === 'working'
              ? 'bg-muted-foreground/50 animate-pulse'
              : 'bg-muted-foreground/50',
        )}
      />
      <span className="truncate">{label.text}</span>
    </span>
  )
}

/**
 * What the parser could not read in the doc: a small mark, the details on
 * hover. Grey on a card (only "needs you" is coloured there).
 */
export function WarningMark({
  warnings,
  quiet,
}: {
  warnings: string[]
  quiet?: boolean
}) {
  if (!warnings.length) return null
  const text = `The doc has ${warnings.length === 1 ? 'a problem' : `${warnings.length} problems`}: ${warnings.join('; ')}`
  return (
    <span
      title={text}
      aria-label={text}
      role="img"
      className={cn(
        'relative z-10 inline-flex',
        quiet ? 'text-muted-foreground' : 'text-status-pending',
      )}
    >
      <AlertTriangle className="size-3.5" aria-hidden />
    </span>
  )
}

const UNPUBLISHED =
  'A session has changes to this doc that are not on GitHub yet'

/** The words on the item page; just the icon, in grey, on a card. */
export function UnpublishedMark({
  quiet,
  className,
}: {
  quiet?: boolean
  className?: string
}) {
  if (quiet)
    return (
      <span
        title={UNPUBLISHED}
        aria-label="Unpublished changes"
        role="img"
        className={cn('relative z-10 inline-flex', className)}
      >
        <CloudOff className="size-3.5" aria-hidden />
      </span>
    )
  return (
    <span
      title={UNPUBLISHED}
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1 text-xs',
        className,
      )}
    >
      <CloudOff className="size-3.5" aria-hidden />
      unpublished changes
    </span>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
      {children}
    </h3>
  )
}
