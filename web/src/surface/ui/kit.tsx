import { useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  CircleHelp,
  Clock,
  Ellipsis,
  FileDiff,
  FileText,
  GitPullRequest,
  Globe,
  ListTree,
  PanelLeft,
  PanelRight,
  RectangleHorizontal,
  SquarePen,
  Square,
  SunMoon,
} from 'lucide-react'
import type { ResultRow } from '@opencomputer/sdk/computer'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { cn } from '@/lib/utils'

// The surface's shared non-component pieces: icons, class strings, labels and
// the confirm hook. Components live in bits.tsx (kept apart for fast refresh).

const ic = 'size-3.5'
export const I = {
  pr: <GitPullRequest className={ic} />,
  files: <FileDiff className={ic} />,
  globe: <Globe className={ic} />,
  doc: <FileText className={ic} />,
  chev: <ChevronDown className="size-3" />,
  track: <ListTree className={ic} />,
  dots: <Ellipsis className="size-4" />,
  stop: <Square className="size-2.5 fill-current" />,
  check: <Check className={ic} />,
  clock: <Clock className={ic} />,
  up: <ArrowUp className={ic} />,
  back: <ArrowLeft className={ic} />,
  side: <PanelLeft className="size-4" />,
  compose: <SquarePen className="size-4" />,
  theme: <SunMoon className="size-4" />,
  help: <CircleHelp className="size-4" />,
  L1: <PanelLeft className="size-4" />,
  L2: <PanelRight className="size-4" />,
  L3: <RectangleHorizontal className="size-4" />,
}

// The Mac app has no title bar: the top bars drag the window (spec 24), and
// what can be clicked in them does not.
export const DRAG =
  'in-data-[platform=desktop]:[-webkit-app-region:drag] in-data-[platform=desktop]:[&_:is(button,a,input,[role=group])]:[-webkit-app-region:no-drag]'

// A pane's top bar.
export const HD = cn(
  'flex h-12 flex-none items-center gap-2 border-b pr-2 pl-4 whitespace-nowrap select-none',
  DRAG,
)
// The bar at the window's left edge leaves room for the list's button while the list is hidden.
export const LEFT = 'in-data-[list=hidden]:pl-12'

// A pane's column, which keeps its width while the pane animates.
export const IN = 'flex h-full min-w-[340px] flex-col'
// A pane's composer, on the conversation's measure.
export const COMPOSER = 'mx-4 mt-2 mb-4 max-w-180'
// A block in a conversation: a proposal or an ask, with its buttons.
export const BLOCK = 'bg-card max-w-140 rounded-lg border px-4 py-3'
export const ACTS = 'mt-3 flex flex-wrap items-center gap-2'

export function resultTitle(r: ResultRow): string {
  if (r.title) return r.title
  const pr = r.type === 'pr' ? /\/pull\/(\d+)/.exec(r.ref) : null
  return pr ? `PR #${pr[1]}` : (r.ref.split('/').pop() ?? r.ref)
}

// "open · checks passed", "+11,486 −493", "running".
export function resultDetail(r: ResultRow): string {
  const m = r.meta ?? {}
  if (typeof m.detail === 'string') return m.detail
  const parts: string[] = []
  if (r.state) parts.push(r.state)
  if (r.type === 'pr' && typeof m.checks === 'string')
    parts.push(`checks ${m.checks}`)
  if (typeof m.additions === 'number' && typeof m.deletions === 'number')
    parts.push(
      `+${m.additions.toLocaleString()} −${m.deletions.toLocaleString()}`,
    )
  return parts.join(' · ')
}

// Escape closes this layer only (R19): the surface's own Escape never sees it.
export const oneLayer = (e: KeyboardEvent) => e.stopPropagation()

// ---- asking before something that cannot be taken back ----

export interface Ask {
  title: string
  description?: string
  confirmLabel: string
  destructive?: boolean
  onConfirm(): void
}

// `ask(...)` opens the dialog; render `dialog` once in the component.
export function useConfirm(): [(a: Ask) => void, ReactNode] {
  const [a, setA] = useState<Ask | null>(null)
  const dialog = (
    <ConfirmDialog
      open={!!a}
      onOpenChange={(open) => !open && setA(null)}
      title={a?.title ?? ''}
      description={a?.description}
      confirmLabel={a?.confirmLabel}
      destructive={a?.destructive}
      onConfirm={() => {
        a?.onConfirm()
        setA(null)
      }}
    />
  )
  return [setA, dialog]
}

export const when = (
  iso: string | number | null | undefined,
  now = Date.now(),
): string => {
  if (!iso) return ''
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime()
  const d = new Date(t)
  const days = Math.floor(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) /
      86400000,
  )
  if (days <= 0) return 'today'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
