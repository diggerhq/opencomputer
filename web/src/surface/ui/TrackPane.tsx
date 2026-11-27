import { lazy, Suspense, useState, type ReactNode } from 'react'
import type {
  Answer,
  Ask,
  DocRow,
  ProposalRow,
} from '@opencomputer/sdk/computer'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useS, useSurface, useTrack } from '../hooks'
import { askLine, type ThreadView, type TrackView } from '../store/views'
import { I } from './icons'
import { ACTS, BLOCK, COMPOSER, HD, IN, LEFT, MEASURE } from './pane-classes'
import { resultDetail, resultTitle } from './result-text'
import { useConfirm } from './use-confirm'
import { Mk } from './Mark'
import { ResultIcon } from './ResultIcon'
import { Rich } from './Rich'
import { Composer } from './Composer'
import { MenuButton, type MenuItem } from './MenuButton'
import { AgentMarkdown } from '@/managed-agents/AgentMarkdown'
import { Conversation } from './Conversation'
import { SettingsPickers } from './SettingsPickers'

const DocEditor = lazy(() =>
  import('./DocEditor').then((m) => ({ default: m.DocEditor })),
)

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
    ...(surface.canLink
      ? [{ label: 'Copy link', onSelect: () => surface.copyLink({ track: tid }) }]
      : []),
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
          <span className="text-muted-foreground text-meta inline-flex items-center gap-1">
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
      <div className="flex-none border-b px-4 pt-1">
        <Tabs
          value={tab}
          onValueChange={(v) =>
            surface.setTrackTab(tid, v as 'activity' | 'doc' | 'results')
          }
        >
          <TabsList variant="line">
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
        // Held to part of the pane, so the agent's conversation and composer
        // stay in sight. It scrolls down, never sideways.
        <div className="flex max-h-[40%] flex-none flex-col gap-2 overflow-x-hidden overflow-y-auto border-b px-4 pt-3 pb-1">
          {track.threads.map((t) => (
            <Card key={t.id} thread={t} sel={open === t.id} />
          ))}
          {track.earlier > 0 && (
            <button
              className="text-faint hover:text-muted-foreground text-meta self-start pt-1 pb-2 text-left outline-none focus-visible:underline"
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
                    'text-muted-foreground hover:text-foreground text-meta -mx-2 flex h-6.5 items-baseline gap-2 px-2 text-left',
                  )}
                  onClick={() => surface.openThread(t.id)}
                >
                  <span className="max-w-[60%] flex-none truncate">
                    {t.title}
                  </span>
                  {t.outcome && (
                    <small className="text-faint min-w-0 truncate text-xs">
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
        tools={
          track.agent &&
          !track.agent.origin.slack && (
            <SettingsPickers
              value={{
                model: track.agent.settings.model ?? undefined,
                effort: track.agent.settings.effort ?? undefined,
              }}
              onChange={(p) => surface.setSettings(track.agentSession, p)}
            />
          )
        }
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

// A result is settled once nothing more comes of it: a pull request merged or
// closed, a preview stopped.
const settled = (r: ThreadView['results'][number]) =>
  r.state === 'merged' || r.state === 'closed' || r.state === 'stopped'

// The one result a card shows: the one waiting on the user, else the newest
// unsettled one. The rest are in the Results view, a click away.
function cardResult(t: ThreadView) {
  return (
    t.results.find((r) => r.id === t.readyResult) ??
    [...t.results].reverse().find((r) => !settled(r)) ??
    null
  )
}

const CHIP =
  'hover:bg-accent hover:text-foreground -mx-1.5 -my-0.5 inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 whitespace-nowrap'

function Card({ thread: t, sel }: { thread: ThreadView; sel: boolean }) {
  const surface = useSurface()
  const ask = t.mark === 'blocked' ? t.ask : null
  const question = ask ? askLine(ask) : null
  const opts = ask ? choices(ask) : []
  const shown = cardResult(t)
  const more = t.results.length - (shown ? 1 : 0)
  const body: ReactNode = (
    <>
      <div className="flex items-baseline gap-2">
        <Mk mark={t.mark} />
        <span
          className={cn(
            'text-reading min-w-0 truncate',
            t.unread ? 'font-semibold' : 'font-medium',
          )}
        >
          {t.title}
        </span>
        {/* The mark says working and ready; only what waits on the person
            is also said in words. */}
        {t.mark === 'blocked' && (
          <span className="text-meta text-status-pending ml-auto flex-none whitespace-nowrap">
            {t.word}
          </span>
        )}
      </div>
      <div className="text-muted-foreground text-meta mt-1 line-clamp-2 wrap-anywhere">
        {t.line ?? 'Just started'}
      </div>
      {ask && (question !== t.line || opts.length > 0) && (
        // An approval's line is often a command with nowhere to break.
        <div className="text-meta mt-2 wrap-anywhere">
          {question !== t.line && <div>{question}</div>}
          {opts.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {opts.map((o) => (
                <Button
                  key={o.label}
                  size="xs"
                  variant={o.primary ? 'default' : 'outline'}
                  className="h-auto min-h-6 max-w-full py-0.5 text-left whitespace-normal"
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
        <div className="text-muted-foreground text-meta mt-2 flex items-center gap-3">
          {shown && (
            <span
              className={cn(CHIP, 'min-w-0')}
              role="button"
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.stopPropagation()
                surface.openResult(shown)
              }}
              onClick={(e) => {
                e.stopPropagation()
                surface.openResult(shown)
              }}
            >
              <ResultIcon result={shown} ring={t.readyResult === shown.id} />
              <span className="truncate">{resultTitle(shown)}</span>
            </span>
          )}
          {more > 0 && (
            <span
              className={cn(CHIP, 'text-faint flex-none')}
              role="button"
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.stopPropagation()
                surface.setTrackTab(t.trackId!, 'results')
              }}
              onClick={(e) => {
                e.stopPropagation()
                surface.setTrackTab(t.trackId!, 'results')
              }}
            >
              {shown
                ? `+${more} more`
                : `${more} ${more === 1 ? 'result' : 'results'}`}
            </span>
          )}
        </div>
      )}
    </>
  )
  const cls = cn(
    'animate-in fade-in-0 block max-w-180 rounded-lg border px-4 py-3 text-left transition-colors outline-none focus-visible:border-ring',
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

const NOTES = cn('flex-1 overflow-auto pb-6 leading-relaxed', MEASURE)

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
  // The Doc the edit started from: a save over a newer one is merged with it.
  const [base, setBase] = useState({
    rev: doc?.rev ?? 0,
    text: doc?.text ?? '',
  })
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
        <p className="text-faint pt-4">
          The Doc appears here once the agent has written the goal.
        </p>
        {proposals}
      </div>
    )

  const text = draft ?? doc.text
  const start = (d: DocRow) => {
    setBase({ rev: d.rev, text: d.text })
    setEditing(true)
  }
  const close = () => {
    surface.setDraft(key, '')
    setEditing(false)
  }
  // The agent wrote to the Doc since the edit began: the save merges.
  const moved = doc.rev !== base.rev
  const save = () => {
    if (text === base.text) return close()
    // Shown at once; the editor comes back only if the save fails.
    setEditing(false)
    surface.saveDoc(tid, text, base).then(
      () => {
        if (surface.get().drafts[key] === text) surface.setDraft(key, '')
      },
      () => {
        if (surface.get().drafts[key] === undefined) surface.setDraft(key, text)
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
          {moved && (
            <p className="text-muted-foreground text-meta mb-2 max-w-180">
              The agent changed the Doc while you were editing. Saving keeps
              both; where you both changed the same lines, yours are kept.
            </p>
          )}
          <Suspense fallback={null}>
            <DocEditor
              value={text}
              onChange={(v) => surface.setDraft(key, v)}
              onSave={save}
            />
          </Suspense>
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

const RG = 'text-faint mt-3 mb-1 text-xs font-medium'

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
      <small className="text-faint ml-auto min-w-0 truncate text-xs tabular-nums">
        {resultDetail(r)}
      </small>
    </div>
  )
  return (
    <div className={cn('flex-1 overflow-auto pt-2 pb-4 *:max-w-180', MEASURE)}>
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
        <p className="text-faint pt-2">
          Nothing yet. Pull requests, previews and files show up here as the
          threads produce them.
        </p>
      )}
    </div>
  )
}
