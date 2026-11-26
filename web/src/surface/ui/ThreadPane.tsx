import { useState } from 'react'
import type { ProposalRow } from '@opencomputer/sdk/computer'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useList, useS, useSurface, useThread, useTrack } from '../hooks'
import type { Layout } from '../store'
import type { ThreadView } from '../store/views'
import {
  ACTS,
  BLOCK,
  COMPOSER,
  Composer,
  HD,
  I,
  IN,
  MenuButton,
  Rich,
  ResultIcon,
  Tip,
  resultDetail,
  resultTitle,
  useConfirm,
  type MenuItem,
} from './bits'
import { Conversation } from './Conversation'

// S3: the thread pane.

const LAYOUTS: { v: Layout; tip: string }[] = [
  { v: 'L1', tip: 'Thread wide  1' },
  { v: 'L2', tip: 'Track wide  2' },
  { v: 'L3', tip: 'Thread only  3' },
]

function Name({
  thread,
  editing,
  setEditing,
}: {
  thread: ThreadView
  editing: boolean
  setEditing: (on: boolean) => void
}) {
  const surface = useSurface()
  if (!editing)
    return (
      <h1
        className="truncate text-sm font-semibold select-text"
        onDoubleClick={() => setEditing(true)}
      >
        {thread.title}
      </h1>
    )
  return (
    <input
      ref={(el) => el?.focus()}
      aria-label="Name"
      // The name's own type, so editing it does not move anything.
      className="min-w-20 flex-[0_1_320px] bg-transparent p-0 text-sm font-semibold outline-none"
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
  const change = thread.results.find(
    (r) => r.type === 'pr' || r.type === 'changes',
  )
  const accept = () => surface.accept(p.id)
  const dismiss = () => surface.dismissProposal(p.id)
  return (
    <div className={BLOCK}>
      <Rich
        text={
          p.what ??
          (p.type === 'done'
            ? 'This looks finished.'
            : p.type === 'move'
              ? 'This belongs with other work.'
              : 'A suggestion.')
        }
      />
      <div className={ACTS}>
        {p.type === 'done' ? (
          <>
            <Button size="sm" onClick={accept}>
              Done
              <Kbd className="bg-primary-foreground/15 text-primary-foreground">
                E
              </Kbd>
            </Button>
            {change && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => surface.openResult(change)}
              >
                Review changes<Kbd>Space</Kbd>
              </Button>
            )}
          </>
        ) : p.type === 'move' ? (
          <>
            <Button size="sm" onClick={accept}>
              Move
            </Button>
            <Button size="sm" variant="outline" onClick={dismiss}>
              Leave it
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={accept}>
              Accept
            </Button>
            <Button size="sm" variant="outline" onClick={dismiss}>
              Dismiss
            </Button>
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
  const [confirm, dialog] = useConfirm()

  if (!thread) return <div className={IN} data-pane="thread" />

  const status = thread.session.status
  const working = status === 'running' || status === 'starting'

  // A typed reply to a single open question is its answer (T3).
  const reply = (text: string) => {
    const ask = thread.ask
    const qs =
      ask?.kind === 'question'
        ? ((ask.question?.questions ?? []) as { id?: string }[])
        : []
    if (ask && qs.length === 1)
      surface.answer(sid, ask.id, {
        answers: [{ questionId: qs[0].id ?? '0', choices: [], text }],
      })
    else surface.send(sid, text)
  }

  const menu = (): MenuItem[] => {
    const others = tracks.filter((k) => k.id !== trackId)
    const items: MenuItem[] = [
      { label: 'Rename', onSelect: () => setRenaming(sid) },
    ]
    if (!trackId && !thread.done)
      items.push({ label: 'Track it', onSelect: () => surface.trackIt(sid) })
    if (others.length)
      items.push({
        label: 'Move to a track',
        items: others.map((k) => ({
          label: k.name,
          onSelect: () => surface.place(sid, k.id),
        })),
      })
    if (trackId)
      items.push({
        label: 'Take out of track',
        onSelect: () => surface.place(sid, null),
      })
    if (!thread.done)
      items.push({
        label: 'Mark done',
        onSelect: () => {
          if (thread.mark !== 'blocked') return surface.done(sid)
          confirm({
            title: `"${thread.title}" is waiting on you`,
            description: 'Mark it done anyway?',
            confirmLabel: 'Mark done',
            onConfirm: () => surface.done(sid),
          })
        },
      })
    if (thread.done || thread.earlier)
      items.push({ label: 'Bring back', onSelect: () => surface.reopen(sid) })
    if (!thread.done)
      items.push({
        label: thread.keep ? 'Stop keeping' : 'Keep in list',
        onSelect: () => surface.keep(sid, !thread.keep),
      })
    items.push('sep', {
      label: 'Delete',
      danger: true,
      onSelect: () =>
        confirm({
          title: `Delete "${thread.title}"?`,
          description: 'This cannot be undone.',
          confirmLabel: 'Delete',
          destructive: true,
          onConfirm: () => surface.deleteThread(sid),
        }),
    })
    return items
  }

  return (
    <div className={IN} data-pane="thread">
      {dialog}
      <div
        className={cn(
          HD,
          'in-data-[list=hidden]:in-data-[mode=t]:pl-12 max-[960px]:in-data-[list=hidden]:pl-12',
        )}
      >
        <Name
          thread={thread}
          editing={renaming === sid}
          setEditing={(on) => setRenaming(on ? sid : null)}
        />
        <span className="text-muted-foreground truncate text-[13px] select-text">
          {thread.done ? (
            <span className="inline-flex items-center gap-1">
              {I.check}
              {thread.outcome ?? 'done'}
            </span>
          ) : track && layout === 'L3' ? (
            `in ${track.name}`
          ) : (
            ''
          )}
        </span>
        <span className="flex-1" />
        {working && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => surface.stop(sid)}
          >
            {I.stop}Stop
          </Button>
        )}
        {!trackId && !thread.done && (
          <Tip label="Give this room to grow: a goal, a doc, more threads  T">
            <Button
              variant="outline"
              size="sm"
              onClick={() => surface.trackIt(sid)}
            >
              {I.track}Track it
            </Button>
          </Tip>
        )}
        {trackId && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            className="max-[960px]:hidden"
            value={layout ?? 'L1'}
            onValueChange={(v) => v && surface.setLayout(trackId, v as Layout)}
          >
            {LAYOUTS.map((l) => (
              <Tip key={l.v} label={l.tip}>
                <ToggleGroupItem
                  value={l.v}
                  aria-label={l.tip}
                  className="text-muted-foreground px-2"
                >
                  {I[l.v]}
                </ToggleGroupItem>
              </Tip>
            ))}
          </ToggleGroup>
        )}
        <MenuButton items={menu} />
      </div>
      {thread.results.length > 0 && (
        <div className="flex max-h-[73px] flex-none flex-wrap gap-2 overflow-hidden border-b px-4 py-2">
          {thread.results.map((r) => {
            const detail = resultDetail(r)
            return (
              <Button
                key={r.id}
                variant="outline"
                size="xs"
                className="font-normal"
                onClick={() => surface.openResult(r)}
              >
                <ResultIcon result={r} ring={thread.readyResult === r.id} />
                {resultTitle(r)}
                {detail && (
                  <small className="text-muted-foreground text-[11.5px] tabular-nums @max-[560px]:hidden">
                    {detail}
                  </small>
                )}
              </Button>
            )
          })}
        </div>
      )}
      <Conversation sid={sid}>
        {thread.proposals.map((p) => (
          <Proposal key={p.id} p={p} thread={thread} />
        ))}
      </Conversation>
      <Composer
        draftKey={`t:${sid}`}
        placeholder="Reply in this thread…"
        onSend={reply}
        className={COMPOSER}
      />
    </div>
  )
}
