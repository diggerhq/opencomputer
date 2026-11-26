import { useState, type ReactNode } from 'react'
import type { Answer, Ask, DocRow, ProposalRow } from '@opencomputer/sdk/computer'
import { useS, useSurface, useTrack } from '../hooks'
import { askLine, type ThreadView, type TrackView } from '../store/views'
import { Composer, I, MenuButton, Mk, ResultIcon, Rich, resultDetail, resultTitle, type MenuItem } from './bits'
import { Conversation } from './Conversation'
import './track.css'

// The track pane (S2): name, stand, and one of Activity, Doc or Results.

export function TrackPane({ tid }: { tid: string }) {
  const surface = useSurface()
  const track = useTrack(tid)
  const tab = useS((s) => s.trackTab[tid] ?? 'activity')
  const [renaming, setRenaming] = useState(false)
  if (!track) return <div className="in" data-pane="track" />

  const nres = [...track.threads, ...track.earlierThreads].reduce((n, t) => n + t.results.length, 0)

  const markDone = () => {
    // T11: what is still going is named before it goes with the track.
    const going = track.threads.filter((t) => t.mark)
    if (
      going.length &&
      !window.confirm(
        `Mark "${track.name}" done?\n\nStill going: ${going.map((t) => `${t.title} (${t.word})`).join(', ')}. Anything working is stopped.`,
      )
    )
      return
    surface.trackDone(tid)
  }

  const menu = (): MenuItem[] => [
    { label: 'Rename', onSelect: () => setRenaming(true) },
    ...(track.done
      ? [{ label: 'Reopen', onSelect: () => surface.trackReopen(tid) }]
      : [
          { label: 'Stop all', onSelect: () => surface.stopAll(tid) },
          { label: 'Mark done', onSelect: markDone },
          {
            label: track.keep ? 'Stop keeping open' : 'Keep open',
            onSelect: () => surface.trackKeep(tid, !track.keep),
          },
        ]),
    'sep',
    {
      label: 'Dissolve track',
      onSelect: () => {
        if (window.confirm(`Dissolve "${track.name}"? Its conversation and Doc go; its threads stay, on their own.`))
          surface.dissolve(tid)
      },
    },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => {
        if (window.confirm(`Delete "${track.name}" for good? Its threads are deleted too.`)) surface.deleteTrack(tid)
      },
    },
  ]

  const seg = (id: 'activity' | 'doc' | 'results', label: string) => (
    <button className={tab === id ? 'on' : ''} onClick={() => surface.setTrackTab(tid, id)}>
      {label}
    </button>
  )

  return (
    <div className="in" data-pane="track">
      <div className="hd">
        {renaming ? (
          <input
            className="rn"
            ref={focus}
            defaultValue={track.name}
            aria-label="Name"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              if (e.currentTarget.value.trim() !== track.name) surface.renameTrack(tid, e.currentTarget.value)
              setRenaming(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') {
                // Leaving with the old name saves nothing.
                e.currentTarget.value = track.name
                e.currentTarget.blur()
              }
              e.stopPropagation()
            }}
          />
        ) : (
          <h1 onDoubleClick={() => setRenaming(true)}>{track.name}</h1>
        )}
        {track.done && (
          <span className="sub">
            <span className="donetag">{I.check}done</span>
          </span>
        )}
        <span className="sp" />
        <MenuButton items={menu} />
      </div>
      <div className="stand" data-stand={tid}>
        {track.stand}
      </div>
      <div className="strip" style={{ padding: '6px var(--edge)' }}>
        <div className="seg2">
          {seg('activity', 'Activity')}
          {seg('doc', 'Doc')}
          {seg('results', `Results${nres ? ` · ${nres}` : ''}`)}
        </div>
      </div>
      {tab === 'doc' ? (
        <Doc key={tid} track={track} />
      ) : tab === 'results' ? (
        <Results track={track} />
      ) : (
        <Activity track={track} />
      )}
    </div>
  )
}

// A stable ref, so the field takes focus once, when it appears.
const focus = (el: HTMLElement | null) => {
  el?.focus()
}

// ---- Activity ----

function Activity({ track }: { track: TrackView }) {
  const surface = useSurface()
  const tid = track.id
  const open = useS((s) => s.loc.thread)
  const earlierOpen = useS((s) => !!s.trackEarlierOpen[tid])
  const blocks = track.proposals.filter((p) => p.type !== 'edit')
  return (
    <>
      {(track.threads.length > 0 || track.earlier > 0) && (
        <div className="cards">
          {track.threads.map((t) => (
            <Card key={t.id} thread={t} sel={open === t.id} />
          ))}
          {track.earlier > 0 && (
            <button className="fold" aria-expanded={earlierOpen} onClick={() => surface.toggleEarlier(tid)}>
              {track.earlier} earlier
            </button>
          )}
          {earlierOpen && track.earlierThreads.length > 0 && (
            <div className="elist">
              {track.earlierThreads.map((t) => (
                <button key={t.id} className="erow" onClick={() => surface.openThread(t.id)}>
                  <span className="n">{t.title}</span>
                  {t.outcome && <small>{t.outcome}</small>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Conversation sid={track.agentSession} trackId={tid} id="kconv">
        {blocks.map((p) => (
          <div key={p.id} className="blk">
            <Rich text={p.what ?? (p.type === 'done' ? 'This looks done.' : 'A suggestion')} />
            <div className="acts">
              {p.type === 'done' ? (
                <>
                  <button className="btn p" onClick={() => surface.accept(p.id)}>
                    Done
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      surface.trackKeep(tid, true)
                      surface.dismissProposal(p.id)
                    }}
                  >
                    Keep open
                  </button>
                </>
              ) : (
                <ProposalButtons p={p} />
              )}
            </div>
          </div>
        ))}
      </Conversation>
      <Composer
        draftKey={`k:${tid}`}
        placeholder="Message this track…"
        onSend={(text) => surface.send(track.agentSession, text)}
      />
    </>
  )
}

function ProposalButtons({ p }: { p: ProposalRow }) {
  const surface = useSurface()
  return (
    <>
      <button className="btn p" onClick={() => surface.accept(p.id)}>
        Accept
      </button>
      <button className="btn" onClick={() => surface.dismissProposal(p.id)}>
        Dismiss
      </button>
    </>
  )
}

type Choice = { label: string; primary?: boolean; answer: Answer }

// The choices a card can offer (R16): an approval, or one question with one
// pick. Anything richer is answered in the thread.
function choices(ask: Ask): Choice[] {
  if (ask.kind === 'approval')
    return [
      { label: 'Allow', primary: true, answer: { decision: 'allow' } },
      { label: "Don't allow", answer: { decision: 'deny' } },
    ]
  if (ask.kind !== 'question') return []
  const qs = (ask.question?.questions ?? []) as {
    id: string
    options?: { label: string }[]
    multiSelect?: boolean
  }[]
  const q = qs[0]
  if (qs.length !== 1 || q.multiSelect || !q.options?.length) return []
  return q.options.map((o) => ({
    label: o.label,
    answer: { answers: [{ questionId: q.id, choices: [o.label], text: null }] },
  }))
}

function Card({ thread: t, sel }: { thread: ThreadView; sel: boolean }) {
  const surface = useSurface()
  const ask = t.mark === 'blocked' ? t.ask : null
  const question = ask ? askLine(ask) : null
  const opts = ask ? choices(ask) : []
  const body: ReactNode = (
    <>
      <div className="c1">
        <Mk mark={t.mark} />
        <span className="n" style={t.unread ? { fontWeight: 700 } : { fontWeight: 500 }}>
          {t.title}
        </span>
        <span className={`w ${t.mark ?? ''}`}>{t.word}</span>
      </div>
      <div className="c2">{t.line ?? 'Just started'}</div>
      {ask && (question !== t.line || opts.length > 0) && (
        <div className="cask">
          {question !== t.line && <div>{question}</div>}
          {opts.length > 0 && (
            <div className="acts">
              {opts.map((o) => (
                <button
                  key={o.label}
                  className={`btn ${o.primary ? 'p' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    surface.answer(t.id, ask.id, o.answer)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {t.results.length > 0 && (
        <div className="c3">
          {t.results.map((r) => (
            <span
              key={r.id}
              className="go"
              role="button"
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.stopPropagation()
                surface.openResult(r)
              }}
              onClick={(e) => {
                e.stopPropagation()
                surface.openResult(r)
              }}
            >
              <ResultIcon result={r} ring={t.readyResult === r.id} />
              {resultTitle(r)}
            </span>
          ))}
        </div>
      )}
    </>
  )
  const cls = `card ${sel ? 'sel' : ''}`
  // Buttons cannot sit inside a button, so a card that carries choices is a
  // div that behaves as one.
  return opts.length ? (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      onClick={() => surface.openThread(t.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          surface.openThread(t.id)
        }
      }}
    >
      {body}
    </div>
  ) : (
    <button className={cls} onClick={() => surface.openThread(t.id)}>
      {body}
    </button>
  )
}

// ---- Doc (S4) ----

function Doc({ track }: { track: TrackView }) {
  const surface = useSurface()
  const tid = track.id
  const key = `d:${tid}`
  const doc = useS((s) => s.rows.doc.get(tid))
  const draft = useS((s) => s.drafts[key])
  const beside = useS((s) => s.loc.thread !== null)
  const layout = useS((s) => s.layout[tid] ?? 'L1')
  // Unsaved text found here means the editor was left open.
  const [editing, setEditing] = useState(draft !== undefined)
  // The revision the edit started from, so a save over a newer Doc is refused.
  const [base, setBase] = useState(doc?.rev ?? 0)
  const [clash, setClash] = useState(false)
  const edits = track.proposals.filter((p) => p.type === 'edit')

  const proposals = edits.map((p) => (
    <div key={p.id} className="blk">
      <Rich text={p.what ?? 'A change to the Doc'} />
      {typeof p.args?.text === 'string' && <pre>{p.args.text}</pre>}
      <div className="acts">
        <ProposalButtons p={p} />
      </div>
    </div>
  ))

  if (!doc)
    return (
      <div className="notes doc">
        <p className="quiet" style={{ paddingTop: 16 }}>
          The Doc appears here once the agent has written the goal.
        </p>
        {proposals}
      </div>
    )

  const text = draft ?? doc.text
  const start = (d: DocRow) => {
    setBase(d.rev)
    setClash(false)
    setEditing(true)
  }
  const close = () => {
    surface.setDraft(key, '')
    setClash(false)
    setEditing(false)
  }
  const save = () => {
    if (text === doc.text) return close()
    // Shown at once; the editor comes back only if the server refuses.
    setEditing(false)
    setClash(false)
    surface.saveDoc(tid, text, base).then(
      () => {
        if (surface.get().drafts[key] === text) surface.setDraft(key, '')
      },
      () => {
        if (surface.get().drafts[key] === undefined) surface.setDraft(key, text)
        setClash(true)
        setEditing(true)
      },
    )
  }
  const file = `${track.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'doc'}.md`

  return (
    <div className={`notes doc ${editing ? 'ed' : ''}`}>
      <div className="docbar">
        <span>
          {I.doc}
          {file}
        </span>
        {editing ? (
          <>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn p" onClick={save}>
              Save
            </button>
          </>
        ) : (
          <>
            {beside && (
              <button className="btn" onClick={() => surface.setLayout(tid, layout === 'L2' ? 'L1' : 'L2')}>
                {layout === 'L2' ? 'Narrow' : 'Read wide'}
              </button>
            )}
            <button className="btn" onClick={() => start(doc)}>
              Edit
            </button>
          </>
        )}
      </div>
      {editing ? (
        <>
          {clash && (
            <div className="clash">
              The Doc changed while you were editing
              <button
                className="btn"
                onClick={() => {
                  surface.setDraft(key, '')
                  start(doc)
                }}
              >
                Use theirs
              </button>
            </div>
          )}
          <textarea
            ref={focus}
            spellCheck={false}
            aria-label="Doc"
            data-draft={key}
            value={text}
            onChange={(e) => surface.setDraft(key, e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                save()
              }
              e.stopPropagation()
            }}
          />
        </>
      ) : (
        <>
          {proposals}
          <Rich text={doc.text} />
        </>
      )}
    </div>
  )
}

// ---- Results (R18) ----

function Results({ track }: { track: TrackView }) {
  const surface = useSurface()
  const withRes = track.threads.filter((t) => t.results.length)
  const past = track.earlierThreads.flatMap((t) => t.results)
  const row = (t: ThreadView | null, r: ThreadView['results'][number]) => (
    <div
      key={r.id}
      className={`rl ${t ? '' : 'old'}`}
      data-act="preview"
      role="button"
      tabIndex={0}
      onClick={() => surface.openResult(r)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') surface.openResult(r)
      }}
    >
      <ResultIcon result={r} ring={t?.readyResult === r.id} />
      {resultTitle(r)}
      <small>{resultDetail(r)}</small>
    </div>
  )
  return (
    <div className="notes" style={{ paddingTop: 8 }}>
      {withRes.map((t) => (
        <div key={t.id}>
          <div className="rg">{t.title}</div>
          {t.results.map((r) => row(t, r))}
        </div>
      ))}
      {past.length > 0 && (
        <div>
          <div className="rg">Earlier</div>
          {past.map((r) => row(null, r))}
        </div>
      )}
      {!withRes.length && !past.length && (
        <p className="quiet">Nothing yet. Pull requests, previews and files show up here as the threads produce them.</p>
      )}
    </div>
  )
}
