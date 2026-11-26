import { useState, type ReactNode } from 'react'
import type {
  Answer,
  Ask,
  DocRow,
  ProposalRow,
} from '@opencomputer/sdk/computer'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useS, useSurface, useTrack } from '../hooks'
import { askLine, type ThreadView, type TrackView } from '../store/views'
import {
  ACTS,
  BLOCK,
  COMPOSER,
  Composer,
  HD,
  I,
  IN,
  LEFT,
  MenuButton,
  Mk,
  ResultIcon,
  Rich,
  resultDetail,
  resultTitle,
  useConfirm,
  type MenuItem,
} from './bits'
import { AgentMarkdown } from '@/managed-agents/AgentMarkdown'
import { Conversation } from './Conversation'

// A clickable row in the pane: quiet until hovered or focused.
const ROW =
  'hover:bg-accent focus-visible:bg-accent rounded-md outline-none transition-colors'

// The track pane (S2): name, stand, and one of Activity, Doc or Results.

export function TrackPane({ tid }: { tid: string }) {
  const surface = useSurface()
  const track = useTrack(tid)
  const tab = useS((s) => s.trackTab[tid] ?? 'activity')
  const [renaming, setRenaming] = useState(false)
  const [confirm, dialog] = useConfirm()
  if (!track) return <div className={IN} data-pane="track" />

  const nres = [...track.threads, ...track.earlierThreads].reduce(
    (n, t) => n + t.results.length,
    0,
  )

  const markDone = () => {
    // T11: what is still going is named before it goes with the track.
    const going = track.threads.filter((t) => t.mark)
    if (!going.length) return surface.trackDone(tid)
    confirm({
      title: `Mark "${track.name}" done?`,
      description: `Still going: ${going.map((t) => `${t.title} (${t.word})`).join(', ')}. Anything working is stopped.`,
      confirmLabel: 'Mark done',
      onConfirm: () => surface.trackDone(tid),
    })
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
      onSelect: () =>
        confirm({
          title: `Dissolve "${track.name}"?`,
          description:
            'Its conversation and Doc go; its threads stay, on their own.',
          confirmLabel: 'Dissolve',
          onConfirm: () => surface.dissolve(tid),
        }),
    },
    {
      label: 'Delete',
      danger: true,
      onSelect: () =>
        confirm({
          title: `Delete "${track.name}" for good?`,
          description: 'Its threads are deleted too.',
          confirmLabel: 'Delete',
          destructive: true,
          onConfirm: () => surface.deleteTrack(tid),
        }),
    },
  ]

  return (
    <div className={IN} data-pane="track">
      {dialog}
      <div className={cn(HD, LEFT)}>
        {renaming ? (
          <input
            className="bg-card border-input -ml-1.5 h-7 max-w-180 min-w-0 flex-1 rounded-md border px-1.5 text-sm font-semibold outline-none"
            ref={focus}
            defaultValue={track.name}
            aria-label="Name"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              if (e.currentTarget.value.trim() !== track.name)
                surface.renameTrack(tid, e.currentTarget.value)
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
          <h1
            className="truncate text-sm font-semibold select-text"
            onDoubleClick={() => setRenaming(true)}
          >
            {track.name}
          </h1>
        )}
        {track.done && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[13px]">
            {I.check}done
          </span>
        )}
        <span className="flex-1" />
        <MenuButton items={menu} />
      </div>
      <div
        className="text-muted-foreground border-b px-4 py-2.5 leading-5"
        data-stand={tid}
      >
        {track.stand}
      </div>
      <div className="flex-none border-b px-4 py-1.5">
        <Tabs
          value={tab}
          onValueChange={(v) =>
            surface.setTrackTab(tid, v as 'activity' | 'doc' | 'results')
          }
        >
          <TabsList>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="doc">Doc</TabsTrigger>
            <TabsTrigger value="results">
              Results{nres ? ` · ${nres}` : ''}
            </TabsTrigger>
          </TabsList>
        </Tabs>
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
        <div className="flex flex-col gap-2 border-b px-4 pt-3 pb-1">
          {track.threads.map((t) => (
            <Card key={t.id} thread={t} sel={open === t.id} />
          ))}
          {track.earlier > 0 && (
            <button
              className="text-muted-foreground/80 hover:text-muted-foreground self-start pt-1 pb-2 text-left text-[12.5px] outline-none focus-visible:underline"
              aria-expanded={earlierOpen}
              onClick={() => surface.toggleEarlier(tid)}
            >
              {track.earlier} earlier
            </button>
          )}
          {earlierOpen && track.earlierThreads.length > 0 && (
            <div className="flex flex-col pb-2">
              {track.earlierThreads.map((t) => (
                <button
                  key={t.id}
                  className={cn(
                    ROW,
                    'text-muted-foreground hover:text-foreground -mx-2 flex h-6.5 items-baseline gap-2 px-2 text-left text-[12.5px]',
                  )}
                  onClick={() => surface.openThread(t.id)}
                >
                  <span className="max-w-[60%] flex-none truncate">
                    {t.title}
                  </span>
                  {t.outcome && (
                    <small className="text-muted-foreground/70 min-w-0 truncate text-[11.5px]">
                      {t.outcome}
                    </small>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Conversation sid={track.agentSession} trackId={tid} id="kconv">
        {blocks.map((p) => (
          <div key={p.id} className={BLOCK}>
            <Rich
              text={
                p.what ??
                (p.type === 'done' ? 'This looks done.' : 'A suggestion')
              }
            />
            <div className={ACTS}>
              {p.type === 'done' ? (
                <>
                  <Button size="sm" onClick={() => surface.accept(p.id)}>
                    Done
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      surface.trackKeep(tid, true)
                      surface.dismissProposal(p.id)
                    }}
                  >
                    Keep open
                  </Button>
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
        className={COMPOSER}
      />
    </>
  )
}

function ProposalButtons({ p }: { p: ProposalRow }) {
  const surface = useSurface()
  return (
    <>
      <Button size="sm" onClick={() => surface.accept(p.id)}>
        Accept
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => surface.dismissProposal(p.id)}
      >
        Dismiss
      </Button>
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
      <div className="flex items-baseline gap-2">
        <Mk mark={t.mark} />
        <span
          className={cn(
            'min-w-0 truncate',
            t.unread ? 'font-bold' : 'font-medium',
          )}
        >
          {t.title}
        </span>
        <span
          className={cn(
            'ml-auto flex-none text-xs whitespace-nowrap',
            t.mark ? 'text-status-pending' : 'text-muted-foreground',
          )}
        >
          {t.word}
        </span>
      </div>
      <div className="text-muted-foreground mt-1 line-clamp-2 text-[12.5px]">
        {t.line ?? 'Just started'}
      </div>
      {ask && (question !== t.line || opts.length > 0) && (
        <div className="mt-2 text-[12.5px]">
          {question !== t.line && <div>{question}</div>}
          {opts.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {opts.map((o) => (
                <Button
                  key={o.label}
                  size="xs"
                  variant={o.primary ? 'default' : 'outline'}
                  onClick={(e) => {
                    e.stopPropagation()
                    surface.answer(t.id, ask.id, o.answer)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      {t.results.length > 0 && (
        <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {t.results.map((r) => (
            <span
              key={r.id}
              className="hover:bg-accent hover:text-foreground -mx-1.5 -my-0.5 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 whitespace-nowrap"
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
  const cls = cn(
    'animate-in fade-in-0 block max-w-180 rounded-lg border p-3 text-left shadow-xs transition-colors outline-none focus-visible:border-ring',
    sel ? 'bg-row-selected' : 'bg-card hover:border-input',
  )
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

const NOTES = 'flex-1 overflow-auto px-4 pb-6 leading-relaxed'

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
    <div key={p.id} className={cn(BLOCK, 'my-1 mb-4')}>
      <Rich text={p.what ?? 'A change to the Doc'} />
      {typeof p.args?.text === 'string' && (
        <pre className="bg-muted mt-2 overflow-auto rounded-md border px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {p.args.text}
        </pre>
      )}
      <div className={ACTS}>
        <ProposalButtons p={p} />
      </div>
    </div>
  ))

  if (!doc)
    return (
      <div className={NOTES}>
        <p className="text-muted-foreground/80 pt-4">
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
  const file = `${
    track.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'doc'
  }.md`

  return (
    <div className={cn(NOTES, editing && 'flex flex-col overflow-hidden pb-4')}>
      <div className="bg-background sticky top-0 z-[1] flex max-w-180 items-center gap-1.5 pt-2.5 pb-2 select-none">
        <span className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-xs">
          {I.doc}
          {file}
        </span>
        {editing ? (
          <>
            <Button size="xs" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button size="xs" onClick={save}>
              Save
            </Button>
          </>
        ) : (
          <>
            {beside && (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  surface.setLayout(tid, layout === 'L2' ? 'L1' : 'L2')
                }
              >
                {layout === 'L2' ? 'Narrow' : 'Read wide'}
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => start(doc)}>
              Edit
            </Button>
          </>
        )}
      </div>
      {editing ? (
        <>
          {clash && (
            <div className="text-status-pending mb-2 flex items-center gap-2 text-[12.5px]">
              The Doc changed while you were editing
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  surface.setDraft(key, '')
                  start(doc)
                }}
              >
                Use theirs
              </Button>
            </div>
          )}
          <Textarea
            ref={focus}
            className="bg-card min-h-0 w-full max-w-180 flex-1 resize-none px-3.5 py-3 font-mono text-[12.5px] leading-relaxed md:text-[12.5px]"
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
          <div className="max-w-180">
            <AgentMarkdown>{doc.text}</AgentMarkdown>
          </div>
        </>
      )}
    </div>
  )
}

// ---- Results (R18) ----

const RG = 'text-muted-foreground/80 mt-3 mb-1 text-[11.5px] font-medium'

function Results({ track }: { track: TrackView }) {
  const surface = useSurface()
  const withRes = track.threads.filter((t) => t.results.length)
  const past = track.earlierThreads.flatMap((t) => t.results)
  const row = (t: ThreadView | null, r: ThreadView['results'][number]) => (
    <div
      key={r.id}
      className={cn(
        ROW,
        '-mx-2 flex h-7 items-center gap-2 px-2 whitespace-nowrap',
        t ? 'text-foreground' : 'text-muted-foreground',
      )}
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
      <small className="text-muted-foreground/80 ml-auto min-w-0 truncate text-[11.5px] tabular-nums">
        {resultDetail(r)}
      </small>
    </div>
  )
  return (
    <div className="flex-1 overflow-auto px-4 pt-2 pb-4 *:max-w-180">
      {withRes.map((t) => (
        <div key={t.id}>
          <div className={RG}>{t.title}</div>
          {t.results.map((r) => row(t, r))}
        </div>
      ))}
      {past.length > 0 && (
        <div>
          <div className={RG}>Earlier</div>
          {past.map((r) => row(null, r))}
        </div>
      )}
      {!withRes.length && !past.length && (
        <p className="text-muted-foreground/80 pt-2">
          Nothing yet. Pull requests, previews and files show up here as the
          threads produce them.
        </p>
      )}
    </div>
  )
}
