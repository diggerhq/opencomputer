import {
  memo,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
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
import { ChatTextarea } from '@/components/chat-textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AgentMarkdown } from '@/managed-agents/AgentMarkdown'
import { useS, useSurface } from '../hooks'
import type { Mark } from '../store/views'

// Small pieces every pane uses, on the dashboard's design system
// (components/ui, lucide icons, the tokens in index.css).

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

// The mark of spec section 3: dot (blocked), ring (ready), spinner (working).
const MARK: Record<string, string> = {
  blocked: 'bg-status-pending',
  ready: 'shadow-[inset_0_0_0_2px_var(--status-pending)]',
  working:
    'border-[1.5px] border-muted-foreground border-t-transparent border-r-transparent animate-spin',
}
export function Mk({
  mark,
  small,
  className,
}: {
  mark: Mark
  small?: boolean
  className?: string
}) {
  return (
    <span
      data-mark-dot={mark ?? ''}
      className={cn(
        'relative inline-block flex-none rounded-full',
        small ? 'size-[7px]' : 'size-[9px]',
        mark && MARK[mark],
        className,
      )}
    />
  )
}

const ICON: Record<string, ReactNode> = {
  pr: I.pr,
  changes: I.files,
  preview: I.globe,
  file: I.doc,
  document: I.doc,
}

// A result's icon; the ring instead while it is what the thread waits on (R20).
export function ResultIcon({
  result,
  ring,
}: {
  result: ResultRow
  ring?: boolean
}) {
  return ring ? (
    <span className="inline-flex size-3.5 flex-none items-center justify-center">
      <Mk mark="ready" />
    </span>
  ) : (
    <span className="text-muted-foreground inline-flex flex-none">
      {ICON[result.type] ?? I.doc}
    </span>
  )
}

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

// Markdown as the agents write it, through the dashboard's renderer. One line
// stays inline so it can sit inside other text.
export const Rich = memo(function Rich({ text }: { text: string }) {
  return <AgentMarkdown inline={!text.includes('\n')}>{text}</AgentMarkdown>
})

// A label shown on hover or keyboard focus.
export function Tip({
  label,
  children,
  side,
}: {
  label: ReactNode
  children: ReactElement
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}

// ---- the composer: the dashboard's chat box, whose draft is kept (R44) ----

export function Composer({
  draftKey,
  placeholder,
  onSend,
  autoFocus,
  rows = 1,
  className,
}: {
  draftKey: string
  placeholder: string
  onSend(text: string, e: { meta: boolean }): void
  autoFocus?: boolean
  rows?: number
  className?: string
}) {
  const surface = useSurface()
  const text = useS((s) => s.drafts[draftKey] ?? '')
  const ref = useRef<HTMLDivElement>(null)
  const meta = useRef(false)
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector('textarea')?.focus()
  }, [autoFocus, draftKey])
  const send = () => {
    const t = text.trim()
    if (!t) return
    surface.setDraft(draftKey, '')
    onSend(t, { meta: meta.current })
    meta.current = false
  }
  return (
    <div
      ref={ref}
      className={cn(
        'bg-card focus-within:border-ring/60 flex flex-none items-end gap-1 rounded-xl border p-1 pl-1 shadow-sm transition-colors',
        className,
      )}
    >
      <ChatTextarea
        data-draft={draftKey}
        placeholder={placeholder}
        rows={rows}
        value={text}
        onChange={(e) => surface.setDraft(draftKey, e.target.value)}
        onSend={send}
        onKeyDown={(e) => {
          meta.current = e.metaKey || e.ctrlKey
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
        className="min-h-8 flex-1 border-0 bg-transparent px-2.5 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <Button
        size="icon-sm"
        aria-label="Send"
        title="Send (Enter)"
        disabled={!text.trim()}
        onClick={send}
      >
        {I.up}
      </Button>
    </div>
  )
}

// ---- a menu at a button (S6, S7) ----

export type MenuItem =
  | { label: string; onSelect?(): void; danger?: boolean; items?: MenuItem[] }
  | 'sep'

// Escape closes this layer only (R19): the surface's own Escape never sees it.
export const oneLayer = (e: KeyboardEvent) => e.stopPropagation()

export function MenuButton({
  items,
  label = 'More',
}: {
  items: () => MenuItem[]
  label?: string
}) {
  const render = (list: MenuItem[]) =>
    list.map((it, i) =>
      it === 'sep' ? (
        <DropdownMenuSeparator key={i} />
      ) : it.items ? (
        <DropdownMenuSub key={i}>
          <DropdownMenuSubTrigger>{it.label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent onEscapeKeyDown={oneLayer}>
            {render(it.items)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : (
        <DropdownMenuItem
          key={i}
          variant={it.danger ? 'destructive' : 'default'}
          onSelect={() => it.onSelect?.()}
        >
          {it.label}
        </DropdownMenuItem>
      ),
    )
  return (
    <DropdownMenu modal={false}>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="text-muted-foreground"
          >
            {I.dots}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        onEscapeKeyDown={oneLayer}
      >
        {render(items())}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

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
