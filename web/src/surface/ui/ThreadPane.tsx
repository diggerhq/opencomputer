import { useState, type CSSProperties, type ReactNode } from 'react'
import type { ProposalRow } from '@opencomputer/sdk/computer'
import { useList, useS, useSurface, useThread, useTrack } from '../hooks'
import type { Layout } from '../store'
import type { ThreadView } from '../store/views'
import { Composer, I, MenuButton, Rich, ResultIcon, resultDetail, resultTitle, type MenuItem } from './bits'
import { Conversation } from './Conversation'

// S3: the thread pane. Markup follows the prototype's renderThread.

const LAYOUTS: { v: Layout; tip: string; inner: ReactNode }[] = [
  { v: 'L1', tip: 'Thread wide  1', inner: <path d="M6 3.5v9" /> },
  { v: 'L2', tip: 'Track wide  2', inner: <path d="M10 3.5v9" /> },
  { v: 'L3', tip: 'Thread only  3', inner: null },
]

// The name's own type, so editing it does not move anything.
const NAME_INPUT: CSSProperties = {
  font: 'inherit',
  fontSize: 13.5,
  fontWeight: 650,
  color: 'inherit',
  background: 'none',
  border: 0,
  outline: 0,
  padding: 0,
  margin: 0,
  minWidth: 80,
  flex: '0 1 320px',
}

function Name({ thread, editing, setEditing }: { thread: ThreadView; editing: boolean; setEditing: (on: boolean) => void }) {
  const surface = useSurface()
  if (!editing) return <h1 onDoubleClick={() => setEditing(true)}>{thread.title}</h1>
  return (
    <input
      ref={(el) => el?.focus()}
      aria-label="Name"
      style={NAME_INPUT}
      defaultValue={thread.title}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') {
          const title = e.currentTarget.value.trim()
          if (title && title !== thread.title) surface.rename(thread.id, title)
          setEditing(false)
        } else if (e.key === 'Escape') {
          // Escape here leaves the edit, not the pane.
          e.nativeEvent.stopPropagation()
          setEditing(false)
        }
      }}
    />
  )
}

function Proposal({ p, thread }: { p: ProposalRow; thread: ThreadView }) {
  const surface = useSurface()
  const change = thread.results.find((r) => r.type === 'pr' || r.type === 'changes')
  const accept = () => surface.accept(p.id)
  const dismiss = () => surface.dismissProposal(p.id)
  return (
    <div className="blk">
      <Rich text={p.what ?? (p.type === 'done' ? 'This looks finished.' : p.type === 'move' ? 'This belongs with other work.' : 'A suggestion.')} />
      <div className="acts">
        {p.type === 'done' ? (
          <>
            <button className="btn p" onClick={accept}>
              Done<kbd>E</kbd>
            </button>
            {change && (
              <button className="btn" onClick={() => surface.openResult(change)}>
                Review changes<kbd>Space</kbd>
              </button>
            )}
          </>
        ) : p.type === 'move' ? (
          <>
            <button className="btn p" onClick={accept}>
              Move
            </button>
            <button className="btn" onClick={dismiss}>
              Leave it
            </button>
          </>
        ) : (
          <>
            <button className="btn p" onClick={accept}>
              Accept
            </button>
            <button className="btn" onClick={dismiss}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function ThreadPane({ sid }: { sid: string }) {
  const surface = useSurface()
  const thread = useThread(sid)
  const track = useTrack(thread?.trackId ?? null)
  const tracks = useList().tracks
  const trackId = thread?.trackId ?? null
  const layout = useS((s) => (trackId ? (s.layout[trackId] ?? 'L1') : null))
  // Whose name is being edited, so moving to another thread ends the edit.
  const [renaming, setRenaming] = useState<string | null>(null)

  if (!thread) return <div className="in" data-pane="thread" />

  const status = thread.session.status
  const working = status === 'running' || status === 'starting'
  const pos = LAYOUTS.findIndex((l) => l.v === layout)

  // A typed reply to a single open question is its answer (T3).
  const reply = (text: string) => {
    const ask = thread.ask
    const qs = ask?.kind === 'question' ? ((ask.question?.questions ?? []) as { id?: string }[]) : []
    if (ask && qs.length === 1) surface.answer(sid, ask.id, { answers: [{ questionId: qs[0].id ?? '0', choices: [], text }] })
    else surface.send(sid, text)
  }

  const menu = (): MenuItem[] => {
    const others = tracks.filter((k) => k.id !== trackId)
    const items: MenuItem[] = [{ label: 'Rename', onSelect: () => setRenaming(sid) }]
    if (!trackId && !thread.done) items.push({ label: 'Track it', onSelect: () => surface.trackIt(sid) })
    if (others.length)
      items.push({ label: 'Move to a track', items: others.map((k) => ({ label: k.name, onSelect: () => surface.place(sid, k.id) })) })
    if (trackId) items.push({ label: 'Take out of track', onSelect: () => surface.place(sid, null) })
    if (!thread.done)
      items.push({
        label: 'Mark done',
        onSelect: () => {
          if (thread.mark === 'blocked' && !window.confirm(`"${thread.title}" is waiting on you. Mark it done anyway?`)) return
          surface.done(sid)
        },
      })
    if (thread.done || thread.earlier) items.push({ label: 'Bring back', onSelect: () => surface.reopen(sid) })
    if (!thread.done)
      items.push({ label: thread.keep ? 'Stop keeping' : 'Keep in list', onSelect: () => surface.keep(sid, !thread.keep) })
    items.push('sep', {
      label: 'Delete',
      danger: true,
      onSelect: () => {
        if (window.confirm(`Delete "${thread.title}"? This cannot be undone.`)) surface.deleteThread(sid)
      },
    })
    return items
  }

  return (
    <div className="in" data-pane="thread">
      <div className="hd">
        <Name thread={thread} editing={renaming === sid} setEditing={(on) => setRenaming(on ? sid : null)} />
        <span className="sub">
          {thread.done ? (
            <span className="donetag">
              {I.check}
              {thread.outcome ?? 'done'}
            </span>
          ) : thread.waiting ? (
            thread.waiting
          ) : track && layout === 'L3' ? (
            `in ${track.name}`
          ) : (
            ''
          )}
        </span>
        <span className="sp" />
        {working && (
          <button className="pill" onClick={() => surface.stop(sid)}>
            {I.stop}Stop
          </button>
        )}
        {!trackId && !thread.done && (
          <button
            className="btn mt"
            data-tip="Give this room to grow: a goal, a doc, more threads  T"
            onClick={() => surface.trackIt(sid)}
          >
            {I.track}Track it
          </button>
        )}
        {trackId && (
          <div className="seg">
            <span className="thumb" style={{ transform: `translateX(${Math.max(0, pos) * 29}px)` }} />
            {LAYOUTS.map((l, i) => (
              <button
                key={l.v}
                className={`${layout === l.v ? 'on' : ''}${i === 2 ? ' r' : ''}`}
                data-tip={l.tip}
                aria-label={l.tip}
                onClick={() => surface.setLayout(trackId, l.v)}
              >
                {I.lay(l.inner)}
              </button>
            ))}
          </div>
        )}
        <MenuButton items={menu} />
      </div>
      {thread.results.length > 0 && (
        <div className="strip wrap">
          {thread.results.map((r) => {
            const detail = resultDetail(r)
            return (
              <button key={r.id} className="chip" onClick={() => surface.openResult(r)}>
                <ResultIcon result={r} ring={thread.readyResult === r.id} />
                {resultTitle(r)}
                {detail && <small>{detail}</small>}
              </button>
            )
          })}
        </div>
      )}
      <Conversation sid={sid}>
        {thread.proposals.map((p) => (
          <Proposal key={p.id} p={p} thread={thread} />
        ))}
      </Conversation>
      <Composer draftKey={`t:${sid}`} placeholder="Reply in this thread…" onSend={reply} />
    </div>
  )
}
