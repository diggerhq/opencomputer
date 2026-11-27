import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { useConversation, useSurface } from '../hooks'
import {
  formatDuration,
  type Entry,
  type Item,
  type Step,
} from '../store/transcript'
import { AskBlock } from './AskBlock'
import { I } from './icons'
import { at, following, type Seen } from './follow'
import { Mk } from './Mark'
import { MEASURE } from './pane-classes'
import { Rich } from './Rich'

// The conversation of a thread or of a track's agent: messages, a turn's
// steps (one line once it has ended), structural lines with their Undo, and asks as blocks.

const PAGE = 200
// Where the reader was in each conversation, for when they return (R44), with
// the sizes its items were measured at so the place is found again exactly.
const places = new Map<
  string,
  { top: number; end: boolean; sizes?: VirtualItem[] }
>()

const WARN = 'text-status-pending'
const LINK =
  'text-foreground hover:decoration-muted-foreground underline underline-offset-2'

const dayOf = (iso: string) => new Date(iso).toDateString()

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) /
      86400000,
  )
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  })
}

// ---- a structural line and its Undo (A18) ----

function Line({ item }: { item: Extract<Item, { kind: 'line' }> }) {
  const surface = useSurface()
  // What the track started since, while the person is asked about it (T8u).
  const [started, setStarted] = useState<string[] | null>(null)
  const undo = (id: string) => {
    const s = surface.get()
    const op = s.rows.op.get(id)
    const others =
      op?.name === 'track.create' && op.trackId
        ? [...s.rows.place.values()]
            .filter((p) => p.trackId === op.trackId && p.id !== op.sessionId)
            .map((p) => p.id)
        : []
    if (others.length) setStarted(others)
    else surface.undo(id)
  }
  return (
    <div
      className={cn(
        'text-muted-foreground text-meta flex max-w-180 items-center gap-2',
        item.tone === 'error' && WARN,
      )}
    >
      <span className="min-w-0">
        <Rich text={item.text} />
        {item.undo && !started && (
          <>
            {' · '}
            <button className={LINK} onClick={() => undo(item.undo!)}>
              Undo
            </button>
          </>
        )}
        {item.undo && started && (
          <>
            {` · It started ${started.length} more: `}
            <button className={LINK} onClick={() => surface.undo(item.undo!)}>
              keep{' '}
              {started.length === 1 ? 'it on its own' : 'them on their own'}
            </button>
            {' · '}
            <button
              className={LINK}
              onClick={() => {
                for (const sid of started) surface.deleteThread(sid)
                surface.undo(item.undo!)
              }}
            >
              stop and remove {started.length === 1 ? 'it' : 'them'}
            </button>
            {' · '}
            <button className={LINK} onClick={() => setStarted(null)}>
              cancel
            </button>
          </>
        )}
        {item.undone && (
          <>
            {' · '}
            <s className="text-faint">Undo</s>
          </>
        )}
      </span>
    </div>
  )
}

// ---- a turn's work: one line, open to see its steps, thinking and messages ----

// Inside a fold: a step's arguments read as plain mono, not as chips.
const FOLD_BODY =
  'flex flex-col gap-1.5 border-l pl-3.5 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-foreground'

const FOLD =
  'group text-muted-foreground hover:text-foreground focus-visible:text-foreground flex max-w-full min-w-0 items-center gap-1.5 rounded-sm text-meta outline-none'

function StepLine({ step }: { step: Step }) {
  return (
    <div
      className={cn(
        'text-muted-foreground text-meta [&>svg]:text-faint flex items-baseline gap-2 [&>svg]:relative [&>svg]:top-0.5 [&>svg]:flex-none',
        step.status === 'failed' && WARN,
      )}
    >
      {step.status === 'running' ? (
        <Mk mark="working" small />
      ) : step.status === 'done' ? (
        I.check
      ) : (
        <span>×</span>
      )}
      <span className="min-w-0">
        <Rich text={step.title} />
        {step.status === 'failed' ? ' · failed' : ''}
      </span>
    </div>
  )
}

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`

function EntryView({ entry }: { entry: Entry }) {
  if (entry.kind === 'step') return <StepLine step={entry} />
  if (entry.kind === 'text')
    return (
      <div className="text-foreground/85 text-meta">
        <Rich text={entry.text} />
      </div>
    )
  // Thinking the model hid has nothing to show but its length.
  return (
    <div className="text-faint text-meta">
      {entry.text ? (
        <Rich text={entry.text} />
      ) : (
        `Thought${entry.ms === null ? '' : ` for ${seconds(entry.ms)}`}`
      )}
    </div>
  )
}

// What a running turn is doing: its latest step or thinking (a message it
// left is already in view, or was).
const current = (item: Extract<Item, { kind: 'work' }>) =>
  [...item.entries].reverse().find((en) => en.kind !== 'text')

// What the line says: once settled, how long the turn worked; while running,
// what it is doing now.
function workLabel(item: Extract<Item, { kind: 'work' }>): ReactNode {
  const n = item.entries.filter((en) => en.kind === 'step').length
  const counted = n > 1 ? ` · ${n} steps` : ''
  if (item.settled) {
    if (item.ms !== null && item.ms >= 1000)
      return `Worked for ${formatDuration(item.ms)}`
    return n ? `Ran ${n} ${n === 1 ? 'step' : 'steps'}` : 'Thought'
  }
  const now = current(item)
  return (
    <>
      <span className="truncate">
        {now?.kind === 'step' ? (
          <Rich text={now.title} />
        ) : now?.kind === 'thinking' && now.ms !== null ? (
          `Thought for ${seconds(now.ms)}`
        ) : now ? (
          'Thought'
        ) : (
          'Thinking'
        )}
      </span>
      <span className="flex-none">{counted}</span>
    </>
  )
}

function Work({ item }: { item: Extract<Item, { kind: 'work' }> }) {
  const failed = item.entries.filter(
    (en) => en.kind === 'step' && en.status === 'failed',
  ).length
  // The working mark is for a step running now, not for a turn that is waiting.
  const now = current(item)
  const running =
    !item.settled && now?.kind === 'step' && now.status === 'running'
  return (
    <Collapsible className="-my-1 max-w-180">
      <CollapsibleTrigger className={FOLD}>
        {running ? (
          <Mk mark="working" small />
        ) : (
          <ChevronRight className="size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90" />
        )}
        {workLabel(item)}
        {failed > 0 && (
          <span className={cn(WARN, 'flex-none')}>· {failed} failed</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(FOLD_BODY, 'mt-1.5 ml-1.5')}>
        {item.entries.map((en) => (
          <EntryView key={en.key} entry={en} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---- a subagent: its name, how far it has got, open to see its steps and answer ----

const SUB_END: Record<string, string> = { failed: 'failed', stopped: 'stopped' }

const count = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)

function SubagentView({ item }: { item: Extract<Item, { kind: 'subagent' }> }) {
  const { sub, steps, activity } = item
  const running = sub.status === 'running'
  const progress = [
    running ? activity : (SUB_END[sub.status] ?? null),
    sub.toolCalls
      ? `${sub.toolCalls} ${sub.toolCalls === 1 ? 'tool call' : 'tool calls'}`
      : null,
    sub.tokens ? `${count(sub.tokens)} tokens` : null,
    sub.durationMs ? formatDuration(sub.durationMs) : null,
  ].filter(Boolean)
  const answer = sub.error?.message ?? sub.result
  return (
    <Collapsible
      className="max-w-180 rounded-md border px-3 py-2"
      data-subagent={sub.status}
    >
      <CollapsibleTrigger className={cn(FOLD, 'w-full')}>
        {running ? (
          <Mk mark="working" small />
        ) : sub.status === 'completed' ? (
          I.check
        ) : (
          <span className={cn(sub.status === 'failed' && WARN)}>×</span>
        )}
        <span className="text-foreground truncate font-medium">{sub.name}</span>
        {(sub.agentType || sub.background) && (
          <span className="flex-none">
            {[sub.agentType, sub.background && 'background']
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        <span className="flex-1" />
        <ChevronRight className="size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      {progress.length > 0 && (
        <div
          className={cn(
            'text-muted-foreground text-meta mt-0.5 truncate pl-5 tabular-nums',
            sub.status === 'failed' && WARN,
          )}
        >
          {progress.join(' · ')}
        </div>
      )}
      <CollapsibleContent className={cn(FOLD_BODY, 'mt-2 ml-1.5')}>
        {steps.map((st) => (
          <StepLine key={st.key} step={st} />
        ))}
        {!steps.length && !answer && (
          <div className="text-muted-foreground text-meta">No steps yet</div>
        )}
        {answer && (
          <div
            className={cn(
              'text-foreground/85 text-meta max-h-60 overflow-y-auto',
              sub.error && WARN,
            )}
          >
            <Rich text={answer} />
            {sub.resultTruncated && (
              <span className="text-muted-foreground"> …</span>
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---- one item ----

// A turn on its way, dimmed until it lands, with a word on why.
const PENDING: Record<string, string> = {
  sending: 'Sending…',
  queued: 'Queued',
}

// On the measure like the agent's text, so the reading edge stays put; the
// card and the stronger text say whose turn it is.
// Rows' one-line heights by kind, as drawn (with the gap between rows).
const ESTIMATE: Partial<Record<Item['kind'], number>> = { user: 62, agent: 40, work: 28 }

// A reply, with a caret at the end of its last line while it streams: inside
// the text, so the reply is as tall streaming as it is when complete.
function Reply({ text, streaming }: { text: string; streaming: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!streaming) return
    const last = [...(ref.current?.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre, td') ?? [])].pop()
    last?.classList.add('caret-end')
    return () => last?.classList.remove('caret-end')
  }, [text, streaming])
  return (
    <div ref={ref} className="max-w-180">
      <Rich text={text} size="reading" />
    </div>
  )
}

// A message is drawn as sent at once (B2): "Sending…" only once sending is
// slow, so the usual echo, a moment later, changes nothing drawn.
const SLOW_SEND_MS = 1500

function useLate(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => setLate(true), ms)
    return () => {
      clearTimeout(t)
      setLate(false)
    }
  }, [on, ms])
  return on && late
}

function UserTurn({ item }: { item: Extract<Item, { kind: 'user' }> }) {
  const slow = useLate(item.state === 'sending', SLOW_SEND_MS)
  const pending =
    item.state && (item.state !== 'sending' || slow) && PENDING[item.state]
  return (
    <div className="bg-card text-strong max-w-180 rounded-lg border px-3.5 py-2.5">
      {(item.author || item.via) && (
        <div className="text-muted-foreground text-meta">
          {[item.author, item.via].filter(Boolean).join(' · ')}
        </div>
      )}
      <div className={cn(pending && 'opacity-60')}>
        <Rich text={item.text} size="reading" />
      </div>
      {pending && <div className="text-faint text-meta mt-1">{pending}</div>}
      {item.state === 'failed' && (
        <div className={cn(WARN, 'text-meta mt-1')}>
          Not sent{item.reason ? ` · ${item.reason}` : ''}
        </div>
      )}
    </div>
  )
}

// The transcript is rebuilt whenever an event arrives, so an unchanged item
// is a new object with the same fields: compare those.
const sameItem = (a: { item: Item }, b: { item: Item }) => {
  const x = a.item as unknown as Record<string, unknown>
  const y = b.item as unknown as Record<string, unknown>
  const keys = Object.keys(x)
  return (
    keys.length === Object.keys(y).length && keys.every((k) => x[k] === y[k])
  )
}

const ItemView = memo(function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return <UserTurn item={item} />
    case 'agent':
      return (
        <Reply text={item.text} streaming={!!item.streaming} />
      )
    case 'work':
      return <Work item={item} />
    case 'ask':
      return <AskBlock ask={item.ask} />
    case 'subagent':
      return <SubagentView item={item} />
    case 'line':
      return <Line item={item} />
  }
}, sameItem)

// ---- the scroll area ----

// A day's first item, or the item itself: what the virtual list draws.
type Row = { key: string; day?: string; item?: Item }

function DayLine({ at }: { at: string }) {
  return (
    <div className="text-faint after:bg-border text-meta flex max-w-180 items-center gap-3 font-medium after:h-px after:flex-1 after:content-['']">
      {dayLabel(at)}
    </div>
  )
}

export function Conversation(props: {
  sid: string
  trackId?: string
  children?: ReactNode
  id?: string
}) {
  // One list per conversation: its measured sizes are its own.
  return <Transcript key={props.sid} {...props} />
}

function Transcript(props: {
  sid: string
  trackId?: string
  children?: ReactNode
  id?: string
}) {
  const { sid, trackId, children, id } = props
  const { items } = useConversation(sid, trackId)
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Distance from the end to hold when earlier items are revealed above.
  const hold = useRef<number | null>(null)
  const lastKey = useRef<string | undefined>(undefined)
  // Where the pane was when last looked at, by the reader or by itself.
  const seen = useRef<Seen>({ top: 0, bottom: 0, view: 0 })

  const [n, setN] = useState(PAGE)
  const shown = items.length > n ? items.slice(items.length - n) : items

  const rows: Row[] = []
  let day = ''
  shown.forEach((item, i) => {
    const d = dayOf(item.at)
    if (i > 0 && d !== day) rows.push({ key: `day-${item.key}`, day: item.at })
    day = d
    rows.push({ key: item.key, item })
  })

  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    // A row's height before it is drawn: its kind's one-line height, so a
    // new row (a reply's first words) mounts at about its size, and following
    // the end does not overshoot and come back once it is measured.
    estimateSize: (i) => {
      const r = rows[i]
      return r.day ? 36 : (r.item && ESTIMATE[r.item.kind]) || 72
    },
    getItemKey: (i) => rows[i].key,
    // The list starts below the pane's padding and "Show earlier", which is
    // not counted: the rows drawn either side of the view cover it.
    overscan: 6,
    initialMeasurementsCache: places.get(sid)?.sizes,
  })
  const remember = (el: HTMLDivElement, end: boolean) =>
    places.set(sid, { top: el.scrollTop, end, sizes: v.measurementsCache })
  const toEnd = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight
    seen.current = at(el)
    remember(el, true)
  }
  // Whether the reader has left the end or come back to it since last seen.
  // Every render looks first, since the virtualizer re-renders on a scroll
  // before the pane's own scroll handler runs.
  const look = (el: HTMLDivElement) => {
    const now = at(el)
    pinned.current = following(pinned.current, seen.current, now)
    seen.current = now
  }

  // Opening a conversation: where the reader left it, else its end.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const was = places.get(sid)
    pinned.current = was ? was.end : true
    if (was && !was.end) {
      el.scrollTop = was.top
      seen.current = at(el)
    } else toEnd(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // After every change: follow the end only if the reader is at it. Safari
  // has no scroll anchoring, so content revealed above is compensated here;
  // items measured above the view are compensated by the virtualizer.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    look(el)
    const last = items[items.length - 1]
    // The person's own new message takes them to it.
    if (
      last &&
      last.key !== lastKey.current &&
      last.kind === 'user' &&
      last.state === 'sending'
    )
      pinned.current = true
    lastKey.current = last?.key
    if (hold.current !== null) {
      el.scrollTop = el.scrollHeight - hold.current
      seen.current = at(el)
      hold.current = null
    } else if (pinned.current) toEnd(el)
  })

  // The pane changing size (a growing composer, a layout change) keeps the end in view.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (pinned.current) toEnd(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    look(el)
    remember(el, pinned.current)
  }

  return (
    <div
      className={cn(
        "flex flex-1 [scrollbar-width:thin] flex-col gap-4 overflow-y-auto pt-4 pb-2 [overflow-anchor:none] before:flex-1 before:content-['']",
        MEASURE,
      )}
      id={id}
      ref={ref}
      onScroll={onScroll}
    >
      {items.length > n && (
        <Button
          variant="outline"
          size="sm"
          className="flex-none self-center"
          onClick={() => {
            const el = ref.current
            if (el) hold.current = el.scrollHeight - el.scrollTop
            setN(n + PAGE)
          }}
        >
          Show earlier
        </Button>
      )}
      {rows.length > 0 && (
        <div
          className="relative flex-none"
          style={{ height: v.getTotalSize() }}
        >
          {v.getVirtualItems().map((it) => {
            const row = rows[it.index]
            return (
              <div
                key={it.key}
                ref={v.measureElement}
                data-index={it.index}
                className={cn(
                  'absolute top-0 left-0 flex w-full flex-col',
                  it.index > 0 && 'pt-4',
                )}
                style={{ transform: `translateY(${it.start}px)` }}
              >
                {row.item ? (
                  <ItemView item={row.item} />
                ) : (
                  <DayLine at={row.day!} />
                )}
              </div>
            )
          })}
        </div>
      )}
      {children}
    </div>
  )
}
