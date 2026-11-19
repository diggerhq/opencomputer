import type { ReactNode } from 'react'
import { AlertTriangle, CloudOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '../computer-sessions/transcript'
import type { Item, Person, PullRequest, PullState } from './api'
import { attentionLabel, personName, pullLabel, pullStateWord } from './board'

// Small pieces shared by the board and the item page.

export function Avatar({
  person,
  className,
}: {
  person: Person
  className?: string
}) {
  const name = personName(person)
  return (
    <span
      title={name}
      className={cn(
        'bg-secondary text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium uppercase',
        className,
      )}
    >
      {name.charAt(0)}
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
    'bg-muted text-muted-foreground relative z-10 rounded px-1.5 py-0.5 font-mono text-[11px] leading-4',
    onClick && 'hover:text-foreground cursor-pointer transition-colors',
    active && 'bg-foreground text-background hover:text-background',
  )
  if (!onClick) return <span className={className}>{tag}</span>
  return (
    <button
      type="button"
      className={className}
      title={`Show items tagged ${tag}`}
      onClick={onClick}
    >
      {tag}
    </button>
  )
}

const PULL_DOT: Record<NonNullable<PullState>, string> = {
  open: 'bg-status-running',
  draft: 'bg-status-stopped',
  merged: 'bg-status-hibernated',
  closed: 'bg-status-error',
}

export function PullDot({ state }: { state: PullState }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        state ? PULL_DOT[state] : 'border-muted-foreground/60 border',
      )}
    />
  )
}

/** A pull request as a quiet link with its state; always to GitHub. */
export function PullChip({ pr }: { pr: PullRequest }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={[pr.title, pullStateWord(pr.state)].filter(Boolean).join(' · ')}
      className="text-muted-foreground hover:text-foreground relative z-10 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs tabular-nums transition-colors"
    >
      <PullDot state={pr.state} />
      {pullLabel(pr)}
      {pr.state === 'draft' ? <span>· draft</span> : null}
    </a>
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
              ? 'bg-status-running/60 animate-pulse'
              : 'bg-muted-foreground/50',
        )}
      />
      <span className="truncate">{label.text}</span>
    </span>
  )
}

/** What the parser could not read in the doc: a small mark, the details on hover. */
export function WarningMark({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  const text = `The doc has ${warnings.length === 1 ? 'a problem' : `${warnings.length} problems`}: ${warnings.join('; ')}`
  return (
    <span
      title={text}
      aria-label={text}
      role="img"
      className="text-status-pending relative z-10 inline-flex"
    >
      <AlertTriangle className="size-3.5" aria-hidden />
    </span>
  )
}

export function UnpublishedMark({ className }: { className?: string }) {
  return (
    <span
      title="A session has changes to this doc that are not on GitHub yet"
      className={cn(
        'text-status-pending inline-flex items-center gap-1 text-xs',
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
