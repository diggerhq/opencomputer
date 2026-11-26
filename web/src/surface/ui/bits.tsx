import {
  memo,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { ResultRow } from '@opencomputer/sdk/computer'
import { ChatTextarea } from '@/components/chat-textarea'
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
import { I, oneLayer } from './kit'

// Small pieces every pane uses, on the dashboard's design system
// (components/ui, lucide icons, the tokens in index.css).

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
  onSend: (text: string, e: { meta: boolean }) => void
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
