import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Ask } from '@opencomputer/sdk/computer'
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
import type { Item, Step } from '../store/transcript'
import { ACTS, BLOCK, I, Mk, Rich } from './bits'

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
const ASIDE = 'text-muted-foreground text-[12.5px]'
// An ask still waiting on the person; one that is closed goes quiet.
const askCls = (open: boolean) =>
  cn(
    BLOCK,
    open ? 'bg-status-pending-bg border-status-pending/25' : 'opacity-70',
  )
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

// ---- asks ----

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

// What a closed ask shows in place of its buttons (R33).
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
        ? 'Always allowed'
        : 'Allowed'
  const said = (a.answers ?? []).flatMap((x) => [
    ...(x.choices ?? []),
    ...(x.text ? [x.text] : []),
  ])
  return said.length ? said.join(' · ') : 'Answered'
}

function AskBlock({ ask }: { ask: Ask }) {
  const surface = useSurface()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const open = ask.status === 'open'
  const closed = open ? null : (
    <div className={cn(ASIDE, 'mt-2')}>{answered(ask)}</div>
  )

  if (ask.kind === 'approval') {
    const a = ask.approval ?? {}
    const title =
      typeof a.title === 'string'
        ? a.title
        : typeof a.toolName === 'string'
          ? a.toolName
          : null
    const command = typeof a.command === 'string' ? a.command : null
    return (
      <div className={askCls(open)}>
        <Rich text={command && title ? title : 'Needs your OK'} />
        {(command ?? title) && (
          <pre className="bg-card mt-2 overflow-auto rounded-md border px-3 py-2 font-mono text-xs">
            {command ?? title}
          </pre>
        )}
        {open ? (
          <div className={ACTS}>
            <Button
              size="sm"
              onClick={() =>
                surface.answer(ask.sessionId, ask.id, { decision: 'allow' })
              }
            >
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                surface.answer(ask.sessionId, ask.id, { decision: 'deny' })
              }
            >
              Don't allow
            </Button>
          </div>
        ) : (
          closed
        )}
      </div>
    )
  }

  if (ask.kind === 'question') {
    const qs = questionsOf(ask)
    // One question with one choice is answered by the click itself.
    const direct = qs.length === 1 && !qs[0].multiSelect
    const send = (choices: Record<string, string[]>) =>
      surface.answer(ask.sessionId, ask.id, {
        answers: qs.map((q) => ({
          questionId: q.id,
          choices: choices[q.id] ?? [],
          text: null,
        })),
      })
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
    const ready = qs.every((q) => (picked[q.id] ?? []).length > 0)
    return (
      <div className={askCls(open)}>
        {qs.map((q, i) => (
          <div key={q.id} className={i ? 'mt-3' : undefined}>
            <Rich text={q.text} />
            {open && (
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
            )}
          </div>
        ))}
        {open && !direct && (
          <div className={ACTS}>
            <Button size="sm" disabled={!ready} onClick={() => send(picked)}>
              Send
            </Button>
          </div>
        )}
        {closed}
      </div>
    )
  }

  const name = typeof ask.secret?.name === 'string' ? ask.secret.name : null
  return (
    <div className={askCls(open)}>
      {name ? (
        <>
          This needs a secret:{' '}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
            {name}
          </code>
        </>
      ) : (
        'This needs a secret.'
      )}
      {open ? (
        <div className={ACTS}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => surface.dismissAsk(ask.sessionId, ask.id)}
          >
            Dismiss
          </Button>
        </div>
      ) : (
        closed
      )}
    </div>
  )
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
        'text-muted-foreground flex max-w-180 items-center gap-2 text-[12.5px]',
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
            <s className="text-muted-foreground/70">Undo</s>
          </>
        )}
      </span>
    </div>
  )
}

// ---- steps: listed while the turn runs, one line once it has ended ----

function StepLine({ step }: { step: Step }) {
  return (
    <div
      className={cn(
        'text-muted-foreground flex max-w-180 items-baseline gap-2 text-[12.5px] [&>svg]:relative [&>svg]:top-0.5 [&>svg]:flex-none',
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
      <span>
        <Rich text={step.title} />
        {step.status === 'failed' ? ' · failed' : ''}
      </span>
    </div>
  )
}

function Steps({ item }: { item: Extract<Item, { kind: 'steps' }> }) {
  const lines = (
    <div className="flex flex-col gap-1.5">
      {item.steps.map((st) => (
        <StepLine key={st.key} step={st} />
      ))}
    </div>
  )
  if (!item.settled) return lines
  const n = item.steps.length
  const failed = item.steps.filter((st) => st.status === 'failed').length
  return (
    <Collapsible className="-my-1 max-w-180">
      <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground focus-visible:text-foreground flex items-center gap-1 rounded-sm text-[12.5px] outline-none">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        Ran {n} {n === 1 ? 'step' : 'steps'}
        {failed > 0 && <span className={WARN}>· {failed} failed</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 ml-1.5 border-l pl-3">
        {lines}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---- one item ----

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
      return (
        <div
          className={cn(
            'bg-secondary mr-[max(0px,calc(100%-45rem))] max-w-[min(78%,560px)] self-end rounded-xl rounded-br-sm px-3 py-2',
            (item.state === 'sending' || item.state === 'queued') &&
              'opacity-60',
          )}
        >
          {item.author && (
            <div className="text-muted-foreground text-xs">{item.author}</div>
          )}
          <Rich text={item.text} />
          {item.state === 'failed' && (
            <div className={cn(WARN, 'mt-1 text-xs')}>
              Not sent{item.reason ? ` · ${item.reason}` : ''}
            </div>
          )}
        </div>
      )
    case 'agent':
      return (
        <div className="max-w-180">
          <Rich text={item.text} />
        </div>
      )
    case 'steps':
      return <Steps item={item} />
    case 'ask':
      return <AskBlock ask={item.ask} />
    case 'line':
      return <Line item={item} />
  }
}, sameItem)

// ---- the scroll area ----

// A day's first item, or the item itself: what the virtual list draws.
type Row = { key: string; day?: string; item?: Item }

function DayLine({ at }: { at: string }) {
  return (
    <div className="text-muted-foreground/80 after:bg-border flex max-w-180 items-center gap-3 text-[11.5px] font-medium after:h-px after:flex-1 after:content-['']">
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
  const { items, open } = useConversation(sid, trackId)
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Distance from the end to hold when earlier items are revealed above.
  const hold = useRef<number | null>(null)
  const lastKey = useRef<string | undefined>(undefined)
  // Where this pane last put itself. Its scroll event arrives a frame later,
  // when a pane that is changing width has grown again: it is not the reader's.
  const own = useRef(-1)

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
    estimateSize: (i) => (rows[i].day ? 20 : 72),
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
    own.current = el.scrollTop
    remember(el, true)
  }

  // Opening a conversation: where the reader left it, else its end.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const was = places.get(sid)
    pinned.current = was ? was.end : true
    if (was && !was.end) el.scrollTop = was.top
    else toEnd(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // After every change: follow the end only if the reader is at it. Safari
  // has no scroll anchoring, so content revealed above is compensated here;
  // items measured above the view are compensated by the virtualizer.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
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
    if (!el || el.scrollTop === own.current) return
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    pinned.current = end
    remember(el, end)
  }

  return (
    <div
      className="flex flex-1 [scrollbar-width:thin] flex-col gap-4 overflow-y-auto px-4 pt-4 pb-2 [overflow-anchor:none] before:flex-1 before:content-['']"
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
      {open?.text ? (
        <div className="max-w-180">
          <Rich text={open.text} />
          <span className="bg-foreground/55 ml-0.5 inline-block h-3.5 w-[7px] animate-pulse rounded-[1px] align-[-2px]" />
        </div>
      ) : null}
      {children}
    </div>
  )
}
