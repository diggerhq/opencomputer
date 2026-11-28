import type { Answer, Ask } from '@opencomputer/sdk/computer'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useS, useSurface, useThread } from '../hooks'
import { askLine, type ThreadView } from '../store/views'
import { ago } from './day-label'
import { I } from './icons'
import { Mk } from './Mark'
import { MergeButton } from './MergeButton'
import { ResultIcon } from './ResultIcon'
import { resultTitle } from './result-text'

// A track's threads as rows (work: track layout, round 2): one border around
// a group, a hairline between rows, one line per thread. Only a thread that
// waits on the person grows, by a line of its choices. The same rows are the
// minicards in the track's conversation and the Threads tab.

// A group of rows, in the conversation or under a heading.
export const GROUP =
  'max-w-180 divide-y overflow-hidden rounded-lg border bg-card'

// The rows of a conversation's thread group, read live by id.
export function ThreadGroup({ ids }: { ids: string }) {
  // Those the feed still holds, as a string, so the selector stays stable.
  const here = useS((s) =>
    ids
      .split(',')
      .filter((id) => s.rows.session.has(id) && s.rows.place.has(id))
      .join(','),
  )
  if (!here) return null
  return (
    <div className={GROUP} data-threads>
      {here.split(',').map((id) => (
        <LiveRow key={id} id={id} />
      ))}
    </div>
  )
}

function LiveRow({ id }: { id: string }) {
  const t = useThread(id)
  return t ? <ThreadRow thread={t} /> : null
}

type Choice = { label: string; primary?: boolean; answer: Answer }

// The choices a row can offer (R16): an approval, or one question with one
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

type Result = ThreadView['results'][number]

// A result is settled once nothing more comes of it: a pull request merged or
// closed, a preview stopped.
const settled = (r: Result) =>
  r.state === 'merged' || r.state === 'closed' || r.state === 'stopped'

// The one result a row shows: the one waiting on the user, else the newest
// unsettled one. The rest are in the Results view, a click away.
function rowResult(t: ThreadView) {
  return (
    t.results.find((r) => r.id === t.readyResult) ??
    [...t.results].reverse().find((r) => !settled(r)) ??
    null
  )
}

// A result as short as it can be said beside a title: "#47", "Preview".
function chip(r: Result): string {
  const pr = r.type === 'pr' ? /\/pull\/(\d+)/.exec(r.ref) : null
  if (pr) return `#${pr[1]}`
  if (r.type === 'preview') return 'Preview'
  if (r.type === 'changes') return 'Changes'
  return resultTitle(r)
}

const CHIP =
  'hover:bg-accent hover:text-foreground -my-0.5 inline-flex max-w-40 items-center gap-1.5 rounded-sm px-1.5 py-0.5 whitespace-nowrap'

// What a click inside a row does instead of opening the thread.
const own = (f: () => void) => ({
  onClick: (e: React.MouseEvent) => {
    e.stopPropagation()
    f()
  },
  onKeyDown: (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') f()
  },
})

export function ThreadRow({
  thread: t,
  time,
}: {
  thread: ThreadView
  // The Threads tab says how long ago each moved; the conversation does not.
  time?: boolean
}) {
  const surface = useSurface()
  const sel = useS((s) => s.loc.thread === t.id)
  const ask = t.mark === 'blocked' ? t.ask : null
  const opts = ask ? choices(ask) : []
  const shown = rowResult(t)
  const more = t.results.length - (shown ? 1 : 0)
  const line = t.done
    ? t.outcome
    : ((ask && askLine(ask)) ?? t.line ?? t.waiting ?? 'Just started')
  const open = () => surface.openThread(t.id)
  return (
    // Buttons cannot sit inside a button, so a row is a div that behaves as one.
    <div
      className={cn(
        'animate-in fade-in-0 cursor-default transition-colors outline-none',
        sel ? 'bg-row-selected' : 'hover:bg-accent focus-visible:bg-accent',
      )}
      role="button"
      tabIndex={0}
      data-thread-row={t.id}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <div className="flex h-9 items-center gap-2 px-3">
        <span className="text-faint flex w-4 flex-none justify-center">
          {t.done ? I.check : <Mk mark={t.mark} />}
        </span>
        <span
          className={cn(
            'max-w-[55%] flex-none truncate',
            t.done && 'text-muted-foreground',
            t.unread ? 'font-semibold' : 'font-medium',
          )}
        >
          {t.title}
        </span>
        <span className="text-muted-foreground text-meta min-w-0 flex-1 truncate">
          {line}
        </span>
        {shown && (
          <span
            className={cn(CHIP, 'text-muted-foreground text-xs')}
            role="button"
            tabIndex={-1}
            title={resultTitle(shown)}
            {...own(() => surface.openResult(shown))}
          >
            <ResultIcon result={shown} ring={t.readyResult === shown.id} />
            <span className="truncate">{chip(shown)}</span>
          </span>
        )}
        {shown && <MergeButton result={shown} className="flex-none" />}
        {more > 0 && (
          <span
            className={cn(CHIP, 'text-faint text-xs')}
            role="button"
            tabIndex={-1}
            {...own(() => surface.setTrackTab(t.trackId!, 'results'))}
          >
            {shown ? `+${more}` : `${more} ${more === 1 ? 'result' : 'results'}`}
          </span>
        )}
        {time && (
          <span className="text-faint w-8 flex-none text-right text-xs tabular-nums">
            {ago(t.session.lastActiveAt)}
          </span>
        )}
      </div>
      {opts.length > 0 && (
        <div className="-mt-0.5 flex flex-wrap items-center gap-2 pr-3 pb-2.5 pl-9">
          {opts.map((o) => (
            <Button
              key={o.label}
              size="xs"
              variant={o.primary ? 'default' : 'outline'}
              className="h-auto min-h-6 max-w-full py-0.5 text-left whitespace-normal"
              {...own(() => surface.answer(t.id, ask!.id, o.answer))}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
