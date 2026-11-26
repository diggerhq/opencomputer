import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Ask } from '@opencomputer/sdk/computer'
import { useConversation, useSurface } from '../hooks'
import type { Item } from '../store/transcript'
import { I, Mk, Rich } from './bits'

// The conversation of a thread or of a track's agent: messages, steps as
// single lines, structural lines with their Undo, and asks as blocks.

const PAGE = 200
// Where the reader was in each conversation, for when they return (R44).
const places = new Map<string, { top: number; end: boolean }>()

const DIM: CSSProperties = { opacity: 0.6 }
const INERT: CSSProperties = { opacity: 0.7 }
const WARN: CSSProperties = { color: 'var(--amber-t)' }
const ASIDE: CSSProperties = { color: 'var(--muted)', fontSize: 12.5 }

const dayOf = (iso: string) => new Date(iso).toDateString()

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

// ---- asks ----

type Question = { id: string; text: string; options: { label: string; description?: string }[]; multiSelect?: boolean }

const questionsOf = (ask: Ask): Question[] => {
  const qs = (ask.question?.questions ?? []) as Partial<Question>[]
  return qs.map((q, i) => ({ id: q.id ?? String(i), text: q.text ?? '', options: q.options ?? [], multiSelect: q.multiSelect }))
}

// What a closed ask shows in place of its buttons (R33).
function answered(ask: Ask): string {
  if (ask.status !== 'answered') return ask.status === 'interrupted' ? 'Stopped before it was answered' : 'Dismissed'
  const a = (ask.answer ?? {}) as { decision?: string; answers?: { choices?: string[]; text?: string | null }[] }
  if (a.decision) return a.decision === 'deny' ? 'Not allowed' : a.decision === 'always' ? 'Always allowed' : 'Allowed'
  const said = (a.answers ?? []).flatMap((x) => [...(x.choices ?? []), ...(x.text ? [x.text] : [])])
  return said.length ? said.join(' · ') : 'Answered'
}

function AskBlock({ ask }: { ask: Ask }) {
  const surface = useSurface()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const open = ask.status === 'open'
  const closed = open ? null : <div style={{ ...ASIDE, marginTop: 8 }}>{answered(ask)}</div>

  if (ask.kind === 'approval') {
    const a = ask.approval ?? {}
    const title = typeof a.title === 'string' ? a.title : typeof a.toolName === 'string' ? a.toolName : null
    const command = typeof a.command === 'string' ? a.command : null
    return (
      <div className={open ? 'blk ask' : 'blk'} style={open ? undefined : INERT}>
        <Rich text={command && title ? title : 'Needs your OK'} />
        {(command ?? title) && <pre>{command ?? title}</pre>}
        {open ? (
          <div className="acts">
            <button className="btn p" onClick={() => surface.answer(ask.sessionId, ask.id, { decision: 'allow' })}>
              Allow
            </button>
            <button className="btn" onClick={() => surface.answer(ask.sessionId, ask.id, { decision: 'deny' })}>
              Don't allow
            </button>
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
        answers: qs.map((q) => ({ questionId: q.id, choices: choices[q.id] ?? [], text: null })),
      })
    const pick = (q: Question, label: string) => {
      if (direct) return send({ [q.id]: [label] })
      const have = picked[q.id] ?? []
      const next = q.multiSelect ? (have.includes(label) ? have.filter((l) => l !== label) : [...have, label]) : [label]
      setPicked({ ...picked, [q.id]: next })
    }
    const ready = qs.every((q) => (picked[q.id] ?? []).length > 0)
    return (
      <div className={open ? 'blk ask' : 'blk'} style={open ? undefined : INERT}>
        {qs.map((q, i) => (
          <div key={q.id} style={i ? { marginTop: 12 } : undefined}>
            <Rich text={q.text} />
            {open && (
              <div className="acts">
                {q.options.map((o) => (
                  <button
                    key={o.label}
                    className={(picked[q.id] ?? []).includes(o.label) ? 'btn p' : 'btn'}
                    title={o.description}
                    onClick={() => pick(q, o.label)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {open && !direct && (
          <div className="acts">
            <button className="btn p" disabled={!ready} style={ready ? undefined : DIM} onClick={() => send(picked)}>
              Send
            </button>
          </div>
        )}
        {closed}
      </div>
    )
  }

  const name = typeof ask.secret?.name === 'string' ? ask.secret.name : null
  return (
    <div className={open ? 'blk ask' : 'blk'} style={open ? undefined : INERT}>
      {name ? (
        <>
          This needs a secret: <code>{name}</code>
        </>
      ) : (
        'This needs a secret.'
      )}
      {open ? (
        <div className="acts">
          <button className="btn" onClick={() => surface.dismissAsk(ask.sessionId, ask.id)}>
            Dismiss
          </button>
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
        ? [...s.rows.place.values()].filter((p) => p.trackId === op.trackId && p.id !== op.sessionId).map((p) => p.id)
        : []
    if (others.length) setStarted(others)
    else surface.undo(id)
  }
  return (
    <div className="note" style={item.tone === 'error' ? WARN : undefined}>
      <span>
        <Rich text={item.text} />
        {item.undo && !started && (
          <>
            {' · '}
            <button onClick={() => undo(item.undo!)}>Undo</button>
          </>
        )}
        {item.undo && started && (
          <>
            {` · It started ${started.length} more: `}
            <button onClick={() => surface.undo(item.undo!)}>keep {started.length === 1 ? 'it on its own' : 'them on their own'}</button>
            {' · '}
            <button
              onClick={() => {
                for (const sid of started) surface.deleteThread(sid)
                surface.undo(item.undo!)
              }}
            >
              stop and remove {started.length === 1 ? 'it' : 'them'}
            </button>
            {' · '}
            <button onClick={() => setStarted(null)}>cancel</button>
          </>
        )}
        {item.undone && (
          <>
            {' · '}
            <s style={{ color: 'var(--faint)' }}>Undo</s>
          </>
        )}
      </span>
    </div>
  )
}

// ---- one item ----

// The transcript is rebuilt whenever an event arrives, so an unchanged item
// is a new object with the same fields: compare those.
const sameItem = (a: { item: Item }, b: { item: Item }) => {
  const x = a.item as unknown as Record<string, unknown>
  const y = b.item as unknown as Record<string, unknown>
  const keys = Object.keys(x)
  return keys.length === Object.keys(y).length && keys.every((k) => x[k] === y[k])
}

const ItemView = memo(function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg u" style={item.state === 'sending' || item.state === 'queued' ? DIM : undefined}>
          {item.author && <div style={{ ...ASIDE, fontSize: 12 }}>{item.author}</div>}
          <span className="tx">
            <Rich text={item.text} />
          </span>
          {item.state === 'failed' && (
            <div style={{ ...WARN, fontSize: 12, marginTop: 4 }}>Not sent{item.reason ? ` · ${item.reason}` : ''}</div>
          )}
        </div>
      )
    case 'agent':
      return (
        <div className="msg a">
          <span className="tx">
            <Rich text={item.text} />
          </span>
        </div>
      )
    case 'step':
      return (
        <div className="tool" style={item.status === 'failed' ? WARN : undefined}>
          {item.status === 'running' ? <Mk mark="working" className="sm" /> : item.status === 'done' ? I.check : <span>×</span>}
          <span>
            <Rich text={item.title} />
            {item.status === 'failed' ? ' · failed' : ''}
          </span>
        </div>
      )
    case 'ask':
      return <AskBlock ask={item.ask} />
    case 'line':
      return <Line item={item} />
  }
}, sameItem)

// ---- the scroll area ----

export function Conversation(props: { sid: string; trackId?: string; children?: ReactNode; id?: string }) {
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
  const toEnd = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight
    own.current = el.scrollTop
    places.set(sid, { top: el.scrollTop, end: true })
  }

  const [more, setMore] = useState({ sid, n: PAGE })
  const n = more.sid === sid ? more.n : PAGE
  const shown = items.length > n ? items.slice(items.length - n) : items

  // Opening a conversation: where the reader left it, else its end.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const was = places.get(sid)
    pinned.current = was ? was.end : true
    if (was && !was.end) el.scrollTop = was.top
    else toEnd(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid])

  // After every change: follow the end only if the reader is at it. Safari
  // has no scroll anchoring, so content revealed above is compensated here.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const last = items[items.length - 1]
    // The person's own new message takes them to it.
    if (last && last.key !== lastKey.current && last.kind === 'user' && last.state === 'sending') pinned.current = true
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
  }, [sid])

  const onScroll = () => {
    const el = ref.current
    if (!el || el.scrollTop === own.current) return
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    pinned.current = end
    places.set(sid, { top: el.scrollTop, end })
  }

  const out: ReactNode[] = []
  let day = ''
  shown.forEach((item, i) => {
    const d = dayOf(item.at)
    if (i > 0 && d !== day)
      out.push(
        <div className="day" key={`day-${item.key}`}>
          {dayLabel(item.at)}
        </div>,
      )
    day = d
    out.push(<ItemView key={item.key} item={item} />)
  })

  return (
    <div className="conv" id={id} ref={ref} onScroll={onScroll}>
      {items.length > n && (
        <button
          className="btn"
          style={{ alignSelf: 'center', flex: 'none' }}
          onClick={() => {
            const el = ref.current
            if (el) hold.current = el.scrollHeight - el.scrollTop
            setMore({ sid, n: n + PAGE })
          }}
        >
          Show earlier
        </button>
      )}
      {out}
      {open?.text ? (
        <div className="msg a">
          <span className="tx">
            <Rich text={open.text} />
          </span>
          <span className="caret" />
        </div>
      ) : null}
      {children}
    </div>
  )
}
