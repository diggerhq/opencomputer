import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  parsePatchFiles,
  type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs'
import { FileDiff, Virtualizer } from '@pierre/diffs/react'
import {
  ReviewSummary,
  type ResultRow,
  type Review as Written,
  type ReviewExcerpt,
  type ReviewEye,
} from '@opencomputer/sdk/computer'
import { useS, useSurface, useThread } from '../hooks'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { I } from './icons'
import { HD, LEFT } from './pane-classes'
import { resultTitle } from './result-text'
import { Mk } from './Mark'
import { Rich } from './Rich'

// ---- the diff as GitHub sends it, parsed and drawn by @pierre/diffs ----

interface DiffFile {
  path: string
  tag: string
  add: number
  del: number
  meta: FileDiffMetadata
}

const TAG: Record<FileDiffMetadata['type'], string> = {
  change: '',
  new: 'new file',
  deleted: 'deleted',
  'rename-pure': 'renamed',
  'rename-changed': 'renamed',
}

function parseDiff(text: string): {
  files: DiffFile[]
  add: number
  del: number
} {
  const files = parsePatchFiles(text)
    .flatMap((p) => p.files)
    .map((meta): DiffFile => {
      let add = 0
      let del = 0
      for (const h of meta.hunks) {
        add += h.additionLines
        del += h.deletionLines
      }
      return { path: meta.name, tag: TAG[meta.type], add, del, meta }
    })
  return {
    files,
    add: files.reduce((k, f) => k + f.add, 0),
    del: files.reduce((k, f) => k + f.del, 0),
  }
}

// A file's diff cut to some of its hunks, numbered as in the whole file.
function cut(
  meta: FileDiffMetadata,
  hunks: FileDiffMetadata['hunks'],
): FileDiffMetadata {
  const last = hunks[hunks.length - 1]
  return {
    ...meta,
    hunks,
    unifiedLineCount: last.unifiedLineStart + last.unifiedLineCount,
    splitLineCount: last.splitLineStart + last.splitLineCount,
  }
}

// The opening of a file's change, for a summary that names no excerpts: its
// first hunks, up to about a screenful. Not a judgement of what matters, only
// the start of the diff, with the rest one click away.
const SNIP = 16
function opening(meta: FileDiffMetadata): FileDiffMetadata | null {
  const hunks: FileDiffMetadata['hunks'] = []
  let rows = 0
  for (const h of meta.hunks) {
    if (hunks.length && rows + h.unifiedLineCount > SNIP) break
    hunks.push(h)
    rows += h.unifiedLineCount
  }
  if (hunks.length === meta.hunks.length) return null
  return cut(meta, hunks)
}

// The hunks an excerpt the agent named falls in: its lines, on its side.
function excerpted(
  meta: FileDiffMetadata,
  x: ReviewExcerpt,
): FileDiffMetadata | null {
  const old = x.side === 'old'
  const hunks = meta.hunks.filter((h) => {
    const from = old ? h.deletionStart : h.additionStart
    const n = old ? h.deletionCount : h.additionCount
    return from <= x.end && x.start < from + Math.max(n, 1)
  })
  return hunks.length ? cut(meta, hunks) : null
}

// A summary the agent wrote, if it fits the summary's schema (the SDK's, the
// one Org saves it by). Anything else reads as none written.
function readable(r: Written | null | undefined): Written | null {
  const s = ReviewSummary.safeParse({ head: r?.head, parts: r?.parts })
  return r && s.success ? { ...s.data, resultId: r.resultId } : null
}

// ---- what is held, so reopening is instant ----

function useChange(resultId: string) {
  const surface = useSurface()
  const review = useQuery({
    queryKey: ['surface', 'review', resultId],
    // null: the agent has not written one (or wrote one this cannot read).
    queryFn: () => surface.review(resultId).then(readable, () => null),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const diff = useQuery({
    queryKey: ['surface', 'diff', resultId],
    queryFn: async () => parseDiff(await surface.diff(resultId)),
    retry: false,
    refetchOnWindowFocus: false,
  })
  return { review: review.data, diff: diff.data, failed: diff.isError }
}

// ---- parts: the agent's reading order over the files of the diff ----

// An excerpt with its file and the hunks it falls in (null: not in the diff).
interface Excerpt {
  x: ReviewExcerpt
  file: DiffFile | undefined
  meta: FileDiffMetadata | null
}

interface Part {
  title: string
  claim: string | null
  points: string[]
  eye: ReviewEye[]
  excerpts: Excerpt[]
  // What the agent said of a file, by path.
  notes: Map<string, string>
  // How many files the agent listed, for before the diff arrives.
  listed: number
  files: DiffFile[]
  add: number
  del: number
}

const bare = (title: string, files: DiffFile[]): Part => ({
  title,
  claim: null,
  points: [],
  eye: [],
  excerpts: [],
  notes: new Map(),
  listed: files.length,
  files,
  add: 0,
  del: 0,
})

function group(
  review: Written | null | undefined,
  files: DiffFile[] | undefined,
): Part[] {
  const all = new Map((files ?? []).map((f) => [f.path, f]))
  const byPath = new Map(all)
  const parts: Part[] = (review?.parts ?? []).map((p) => {
    const own: DiffFile[] = []
    for (const { path } of p.files) {
      const f = byPath.get(path)
      if (!f) continue
      // A file named in two parts is read in the first.
      byPath.delete(path)
      own.push(f)
    }
    return {
      ...bare(p.title, own),
      claim: p.claim,
      points: p.points ?? [],
      eye: p.eye ?? [],
      excerpts: (p.excerpts ?? []).map((x) => {
        const file = all.get(x.path)
        return { x, file, meta: file ? excerpted(file.meta, x) : null }
      }),
      notes: new Map(
        p.files.flatMap((f) => (f.note ? [[f.path, f.note]] : [])),
      ),
      listed: p.files.length,
    }
  })
  if (byPath.size)
    parts.push(
      bare(parts.length ? 'Everything else' : '', [...byPath.values()]),
    )
  for (const p of parts) {
    p.add = p.files.reduce((k, f) => k + f.add, 0)
    p.del = p.files.reduce((k, f) => k + f.del, 0)
  }
  return parts
}

// Where the reader is, kept across Summary and Full diff.
interface Place {
  file: string | null
  part: number
  sumTop: number | null
}
const places = new Map<string, Place>()
function placeOf(resultId: string): Place {
  let p = places.get(resultId)
  if (!p) places.set(resultId, (p = { file: null, part: 0, sumTop: null }))
  return p
}

const nf = (n: number) => n.toLocaleString('en-US')
const filesWord = (n: number) => `${nf(n)} ${n === 1 ? 'file' : 'files'}`

// Counts; a zero is faint.
function Pm({
  add,
  del,
  a,
  d,
}: {
  add: number
  del: number
  a?: string
  d?: string
}) {
  return (
    <>
      <span className={cn(add ? 'text-status-running' : 'text-faint', a)}>
        +{nf(add)}
      </span>
      <span className={cn(del ? 'text-status-error' : 'text-faint', d)}>
        −{nf(del)}
      </span>
    </>
  )
}

// A part's number.
const ON_N = 'text-faint w-4 flex-none pt-0.5 font-mono text-xs font-semibold'

// Text that keeps the end of a path when it is cut.
const PATH =
  'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left [direction:rtl]'

// One file's diff, drawn by the library, in the dashboard's light or dark.
function Diff({
  meta,
  header,
  lines,
}: {
  meta: FileDiffMetadata
  header?: boolean
  // Lines to mark: an excerpt the agent named.
  lines?: SelectedLineRange
}) {
  const { dark } = useTheme()
  const options = useMemo(
    () => ({
      themeType: dark ? ('dark' as const) : ('light' as const),
      diffStyle: 'unified' as const,
      // Long lines scroll sideways rather than wrap (S9).
      overflow: 'scroll' as const,
      disableFileHeader: !header,
      stickyHeader: header,
    }),
    [dark, header],
  )
  return <FileDiff fileDiff={meta} options={options} selectedLines={lines} />
}

// A scrolling pane whose diffs the library virtualises (R41): only what is
// near the viewport is drawn. The library owns the scrolling element; this
// hands it to the caller, with its scroll events.
function Pane({
  scrollerRef,
  onScroll,
  className,
  children,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  className?: string
  children: ReactNode
}) {
  const inner = useRef<HTMLDivElement>(null)
  const on = useRef(onScroll)
  useLayoutEffect(() => {
    on.current = onScroll
  })
  useLayoutEffect(() => {
    const el = inner.current!.parentElement!.parentElement as HTMLDivElement
    scrollerRef.current = el
    const f = () => on.current()
    el.addEventListener('scroll', f, { passive: true })
    return () => el.removeEventListener('scroll', f)
  }, [scrollerRef])
  return (
    <Virtualizer
      className={cn('relative min-w-0 flex-1 overflow-y-auto', className)}
    >
      <div ref={inner}>{children}</div>
    </Virtualizer>
  )
}

// A file in the summary: what it is, its counts, and the opening of its
// change; the rest of it, or the file in the full diff, one click away.
function FileSnip({
  file,
  toFull,
}: {
  file: DiffFile
  toFull: (file?: string) => void
}) {
  const [all, setAll] = useState(false)
  const head = useMemo(() => opening(file.meta), [file.meta])
  const shown = all || !head ? file.meta : head
  const more = head ? file.meta.unifiedLineCount - head.unifiedLineCount : 0
  return (
    <div
      className="bg-card ring-border mb-3 overflow-clip rounded-[10px] ring-1"
      data-path={file.path}
    >
      <button
        className="bg-sidebar text-muted-foreground hover:text-foreground border-border/60 flex w-full gap-2.5 border-b px-3 py-2 text-left font-mono text-xs tabular-nums transition-colors"
        title="Open in the full diff"
        onClick={() => toFull(file.path)}
      >
        <span className={PATH}>
          {'‎'}
          {file.path}
        </span>
        {file.tag && <span className="text-faint flex-none">{file.tag}</span>}
        <Pm add={file.add} del={file.del} a="ml-auto" />
      </button>
      {file.meta.hunks.length > 0 ? (
        <Diff meta={shown} />
      ) : (
        <p className="text-muted-foreground px-3 py-2 text-xs">
          {file.tag || 'No lines to show'}
        </p>
      )}
      {head && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'text-muted-foreground text-meta w-full justify-start gap-2 rounded-none border-t px-3 font-normal [&_svg]:transition-transform',
            !all && '[&_svg]:-rotate-90',
          )}
          onClick={() => setAll(!all)}
        >
          {I.chev}
          {all
            ? 'Show the opening only'
            : `Show the rest of this file · ${nf(more)} more ${more === 1 ? 'line' : 'lines'}`}
        </Button>
      )}
    </div>
  )
}

// A part's files: the first few at once, the rest on asking.
const FEW = 8
function PartFiles({
  files,
  toFull,
}: {
  files: DiffFile[]
  toFull: (file?: string) => void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? files : files.slice(0, FEW)
  return (
    <>
      {shown.map((f) => (
        <FileSnip file={f} key={f.path} toFull={toFull} />
      ))}
      {files.length > shown.length && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground text-meta gap-2 px-2 font-normal [&_svg]:-rotate-90"
          onClick={() => setAll(true)}
        >
          {I.chev}
          Show {filesWord(files.length - shown.length)} more
        </Button>
      )}
    </>
  )
}

// A file's path, cut from the left when long.
function PathText({ path }: { path: string }) {
  return (
    <span className={PATH}>
      {'‎'}
      {path}
    </span>
  )
}

// An excerpt the agent named: where it is, what to see in it, and the hunks
// it falls in with its lines marked; the file in the full diff one click away.
function ExcerptCard({
  ex: { x, file, meta },
  toFull,
}: {
  ex: Excerpt
  toFull: (file?: string) => void
}) {
  const lines = useMemo<SelectedLineRange>(() => {
    const side = x.side === 'old' ? 'deletions' : 'additions'
    return {
      start: x.start,
      end: Math.max(x.start, x.end),
      side,
      endSide: side,
    }
  }, [x])
  const where =
    x.end > x.start
      ? `lines ${nf(x.start)}–${nf(x.end)}`
      : `line ${nf(x.start)}`
  return (
    <div
      className="bg-card ring-border mb-3 overflow-clip rounded-[10px] ring-1"
      data-excerpt={x.path}
    >
      <button
        className="bg-sidebar text-muted-foreground hover:text-foreground border-border/60 flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left text-xs transition-colors"
        title="Open in the full diff"
        onClick={() => toFull(x.path)}
      >
        <span className="flex w-full gap-2.5 font-mono tabular-nums">
          <PathText path={x.path} />
          <span className="text-faint ml-auto flex-none">
            {x.side === 'old' ? `${where} before` : where}
          </span>
        </span>
        {x.why && (
          <span className="text-foreground text-meta">
            <Rich text={x.why} />
          </span>
        )}
      </button>
      {meta ? (
        <Diff meta={meta} lines={lines} />
      ) : (
        <p className="text-muted-foreground px-3 py-2 text-xs">
          {file
            ? 'These lines are not in the change.'
            : 'This file is not in the diff.'}
        </p>
      )}
    </div>
  )
}

// A part's files as a list: each with what the agent said of it, and the
// file in the full diff one click away.
function FileList({
  part,
  toFull,
}: {
  part: Part
  toFull: (file?: string) => void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? part.files : part.files.slice(0, FEW * 2)
  return (
    <div className="ring-border mb-3 overflow-clip rounded-[10px] ring-1">
      {shown.map((f) => {
        const note = part.notes.get(f.path)
        return (
          <button
            className="hover:bg-accent border-border/60 flex w-full flex-col gap-0.5 border-b px-3 py-1.5 text-left transition-colors last:border-b-0"
            data-path={f.path}
            key={f.path}
            title="Open in the full diff"
            onClick={() => toFull(f.path)}
          >
            <span className="text-muted-foreground flex w-full gap-2.5 font-mono text-xs tabular-nums">
              <PathText path={f.path} />
              {f.tag && <span className="text-faint flex-none">{f.tag}</span>}
              <Pm add={f.add} del={f.del} a="ml-auto" />
            </span>
            {note && (
              <span className="text-meta leading-normal">
                <Rich text={note} />
              </span>
            )}
          </button>
        )
      })}
      {part.files.length > shown.length && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground text-meta w-full justify-start gap-2 rounded-none px-3 font-normal [&_svg]:-rotate-90"
          onClick={() => setAll(true)}
        >
          {I.chev}
          Show {filesWord(part.files.length - shown.length)} more
        </Button>
      )}
    </div>
  )
}

// ---- Summary ----

function Summary({
  review,
  parts,
  loading,
  failed,
  title,
  heading,
  resultId,
  toFull,
}: {
  review: Written | null
  parts: Part[]
  // The diff has not arrived yet, or could not be had.
  loading: boolean
  failed: boolean
  title: string
  heading: string
  resultId: string
  toFull: (file?: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [cur, setCur] = useState(0)
  const named = parts.length > 0 && parts[0].title !== ''
  const max = Math.max(1, ...parts.map((p) => p.add + p.del))
  const eyes = parts.flatMap((p, i) => p.eye.map((e) => ({ e, i })))
  // The agent named excerpts: they are what the summary shows of the code.
  // Otherwise, each file's opening.
  const excerpts = parts.some((p) => p.excerpts.length > 0)

  const secs = () => [
    ...scroller.current!.querySelectorAll<HTMLElement>('[data-pt]'),
  ]
  const act = () => {
    const c = scroller.current!
    let a = 0
    secs().forEach((s, i) => {
      if (s.offsetTop - 120 <= c.scrollTop) a = i
    })
    setCur(a)
    const p = placeOf(resultId)
    p.sumTop = c.scrollTop
    if (a !== p.part) {
      p.part = a
      p.file = null
    }
  }
  const go = (i: number) => {
    const s = secs()[i]
    if (s) scroller.current!.scrollTop = s.offsetTop + 1
  }
  useLayoutEffect(() => {
    const p = placeOf(resultId)
    if (p.sumTop !== null) scroller.current!.scrollTop = p.sumTop
    else if (p.part) go(p.part)
    // Only on arriving: the place is the reader's from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex min-h-0 flex-1">
      {named && (
        <div className="bg-sidebar w-[320px] flex-none cursor-default overflow-y-auto border-r px-2 py-4 select-none max-[1100px]:w-[240px] max-[700px]:hidden">
          {parts.map((p, i) => (
            <button
              className={cn(
                'focus-visible:bg-accent active:bg-row-selected flex w-full gap-2 rounded-md p-2 text-left leading-snug transition-colors outline-none',
                i === cur
                  ? 'bg-row-selected text-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
              key={i}
              onClick={() => go(i)}
            >
              <span className={ON_N}>{i + 1}</span>
              <span className="min-w-0 flex-1">
                {p.title}
                {p.eye.length > 0 && (
                  <>
                    {' '}
                    <Mk mark="blocked" small className="ml-1 align-[1px]" />
                  </>
                )}
                <span className="mt-1.5 flex h-[3px] w-full gap-0.5">
                  {p.add > 0 && (
                    <i
                      className="bg-status-running rounded-[2px] opacity-70"
                      style={{ width: `${Math.max(3, (p.add / max) * 100)}%` }}
                    />
                  )}
                  {p.del > 0 && (
                    <b
                      className="bg-status-error rounded-[2px] opacity-70"
                      style={{ width: `${Math.max(3, (p.del / max) * 100)}%` }}
                    />
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <Pane scrollerRef={scroller} onScroll={act}>
        <article className="mx-auto max-w-[860px] px-8 pt-10 pb-[40vh] max-[700px]:px-4 max-[700px]:pt-6">
          {review ? (
            <h2 className="mb-3 text-2xl leading-snug font-semibold tracking-tight text-balance">
              <Rich text={heading} />
            </h2>
          ) : (
            <p className="text-muted-foreground mb-4">
              The agent has not written a summary of this change.
              {!failed &&
                ' These are the files it touches, each with the start of its change.'}
            </p>
          )}
          {eyes.length > 0 && (
            <div className="bg-status-pending-bg ring-status-pending/25 mb-2 rounded-[10px] px-4 py-3 ring-1 ring-inset">
              <b className="font-semibold">
                {eyes.length === 1 ? 'One thing' : `${eyes.length} things`}{' '}
                worth your eye
              </b>
              {eyes.map(({ e, i }, k) => (
                <button
                  className="hover:bg-accent focus-visible:bg-accent active:bg-row-selected mt-2 -ml-1 flex w-full items-baseline gap-2.5 rounded-md px-1 py-0.5 text-left transition-colors outline-none"
                  key={k}
                  title={e.path ? 'Open in the full diff' : undefined}
                  onClick={() => (e.path ? toFull(e.path) : go(i))}
                >
                  <Mk mark="blocked" small className="-translate-y-px" />
                  <span className="min-w-0 flex-1">
                    <Rich text={e.text} />
                    {e.path && (
                      <span className="text-muted-foreground ml-2 font-mono text-xs whitespace-nowrap">
                        {e.path}
                        {e.line ? `:${e.line}` : ''}
                      </span>
                    )}
                  </span>
                  {named && (
                    <span className="text-faint flex-none font-mono text-xs">
                      {i + 1}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {parts.map((p, i) => (
            <section
              className={cn(
                named && 'pt-10',
                named && i > 0 && 'border-border/60 mt-10 border-t pt-8',
              )}
              data-pt
              key={i}
            >
              {named && (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className={cn(ON_N, 'text-xs')}>{i + 1}</span>
                    <h3 className="text-lg font-semibold">{p.title}</h3>
                    {p.eye.length > 0 && (
                      <span className="text-status-pending flex-none text-xs whitespace-nowrap">
                        worth your eye
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground text-meta mt-1 mb-3 ml-6 tabular-nums">
                    {filesWord(p.files.length || p.listed)}
                    {p.files.length > 0 && (
                      <>
                        {' · '}
                        <span className="text-status-running">
                          +{nf(p.add)}
                        </span>{' '}
                        <span className="text-status-error">−{nf(p.del)}</span>
                      </>
                    )}
                  </div>
                  {p.claim && (
                    <div className="mb-3 ml-6 max-w-[620px] leading-relaxed text-pretty">
                      <Rich text={p.claim} />
                    </div>
                  )}
                  {p.points.length > 0 && (
                    <ul className="mb-4 ml-6 max-w-[620px] list-disc space-y-1 pl-5 leading-relaxed text-pretty">
                      {p.points.map((t, k) => (
                        <li key={k}>
                          <Rich text={t} />
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <div className={cn(named && 'ml-6')}>
                {excerpts ? (
                  <>
                    {p.excerpts.map((x, k) => (
                      <ExcerptCard ex={x} key={k} toFull={toFull} />
                    ))}
                    {p.files.length > 0 && (
                      <FileList part={p} toFull={toFull} />
                    )}
                  </>
                ) : (
                  <PartFiles files={p.files} toFull={toFull} />
                )}
              </div>
            </section>
          ))}
          {(loading || failed) && (
            <p className="text-muted-foreground mt-6">
              {loading
                ? 'Fetching the diff…'
                : 'The diff could not be fetched.'}
            </p>
          )}
          {parts.some((p) => p.files.length > 0) && (
            <p className="text-muted-foreground mt-14 ml-6">
              That is everything in {title}.{' '}
              <button
                className="text-foreground hover:decoration-muted-foreground/70 underline underline-offset-2"
                onClick={() => toFull()}
              >
                Read the full diff
              </button>{' '}
              if you want every line.
            </p>
          )}
        </article>
      </Pane>
    </div>
  )
}

// ---- Full diff ----

function Full({ parts, resultId }: { parts: Part[]; resultId: string }) {
  const code = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [seen, setCur] = useState<string | null>(null)
  const cur =
    seen ??
    placeOf(resultId).file ??
    parts.find((p) => p.files.length)?.files[0].path ??
    null
  const partOf = useMemo(
    () =>
      new Map(
        parts.flatMap((p, i) => p.files.map((f) => [f.path, i] as const)),
      ),
    [parts],
  )

  const card = (path: string) =>
    code.current!.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(path)}"]`,
    )
  const act = () => {
    const c = code.current!
    let a: HTMLElement | null = null
    for (const el of c.querySelectorAll<HTMLElement>('[data-path]')) {
      if (a && el.offsetTop - 136 > c.scrollTop) break
      a = el
    }
    const path = a?.dataset.path ?? null
    setCur(path)
    if (!path) return
    const p = placeOf(resultId)
    p.file = path
    const part = partOf.get(path) ?? 0
    if (part !== p.part) {
      p.part = part
      p.sumTop = null
    }
  }
  const go = (path: string) => {
    const el = card(path)
    if (el) code.current!.scrollTop = el.offsetTop - 16
  }
  useLayoutEffect(() => {
    const p = placeOf(resultId)
    const el = p.file
      ? card(p.file)
      : p.part
        ? code.current!.querySelector<HTMLElement>(`[data-part="${p.part}"]`)
        : null
    if (el) code.current!.scrollTop = el.offsetTop - 16
    // Only on arriving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The list follows the code, unless the reader is in the list.
  useEffect(() => {
    const l = list.current!
    const item = l.querySelector<HTMLElement>('[data-on]')
    if (item && !l.matches(':hover'))
      l.scrollTop = item.offsetTop - l.clientHeight / 3
  }, [cur])

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="bg-sidebar relative w-[320px] flex-none cursor-default [scrollbar-width:none] overflow-y-auto border-r px-2 pb-[60vh] select-none max-[1100px]:w-[260px] max-[700px]:hidden"
        ref={list}
      >
        {parts.map((p, i) => (
          <div key={i}>
            {p.title && (
              <div className="bg-sidebar text-meta sticky top-0 z-1 flex gap-2 pt-4 pb-1.5 leading-snug font-semibold">
                <span className={ON_N}>{i + 1}</span>
                {p.title}
              </div>
            )}
            {p.files.map((f) => (
              <button
                className={cn(
                  'focus-visible:bg-accent block w-full rounded-md px-2 py-[5px] text-left transition-[opacity,background-color] outline-none',
                  f.path === cur
                    ? 'bg-row-selected'
                    : 'hover:bg-accent opacity-70',
                )}
                data-on={f.path === cur || undefined}
                key={f.path}
                onClick={() => go(f.path)}
              >
                <span className="text-muted-foreground flex gap-2 font-mono text-xs tabular-nums">
                  <span className={cn(PATH, 'flex-1')}>
                    {'‎'}
                    {f.path}
                  </span>
                  <Pm
                    add={f.add}
                    del={f.del}
                    a="min-w-[5ch] text-right"
                    d="min-w-[4ch] text-right"
                  />
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <Pane scrollerRef={code} onScroll={act}>
        <div className="px-6 pt-4 pb-[60vh] max-[700px]:px-4">
          {parts.map((p, i) => [
            p.title && (
              <div
                className="text-reading mt-6 mb-1 font-semibold first:mt-0"
                data-part={i}
                key={`h${i}`}
              >
                {i + 1} · {p.title}
              </div>
            ),
            p.title && p.claim && (
              <div
                className="text-muted-foreground mb-3 max-w-[720px]"
                key={`n${i}`}
              >
                <Rich text={p.claim} />
              </div>
            ),
            p.files.map((f) => (
              <div
                className="ring-border mb-4 overflow-clip rounded-[10px] ring-1"
                data-path={f.path}
                key={f.path}
              >
                <Diff meta={f.meta} header />
              </div>
            )),
          ])}
        </div>
      </Pane>
    </div>
  )
}

// ---- the header: one way back, also Escape (R19) ----

function Head({
  back,
  children,
}: {
  back: string | undefined
  children?: ReactNode
}) {
  const surface = useSurface()
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // One layer at a time: a sheet over the review closes first.
      const s = surface.store.getState()
      if (s.palette || s.keysSheet) return
      e.preventDefault()
      surface.closeResult()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [surface])
  return (
    <div className={cn(HD, LEFT, 'max-[700px]:gap-1')}>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground text-meta -ml-2 min-w-0 gap-1.5 font-normal"
        onClick={() => surface.closeResult()}
      >
        {I.back}
        <span className="truncate">{back ?? 'Back'}</span>
        <Kbd className="ml-0.5 max-[1100px]:hidden">Esc</Kbd>
      </Button>
      {children}
    </div>
  )
}

const isHttp = (ref: string) => /^https?:\/\//.test(ref)

// The header's pieces.
const SUB =
  'text-muted-foreground min-w-0 overflow-hidden text-meta text-ellipsis select-text max-[700px]:hidden'
const SEG =
  'text-muted-foreground h-6 gap-1.5 rounded-sm px-2.5 text-meta font-normal hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm'
// The last button keeps 8px from the edge, but not on a phone.
const BTN = 'text-meta last:mr-2 max-[700px]:last:mr-0'

function Changes({ result }: { result: ResultRow }) {
  const surface = useSurface()
  const thread = useThread(result.sessionId)
  const mode = useS((s) => s.reviewMode)
  const h = useChange(result.id)
  const files = h.diff?.files
  const parts = useMemo(() => group(h.review, files), [h.review, files])
  const title = resultTitle(result)

  return (
    <>
      <Head back={thread?.title}>
        <span className="flex-1" />
        <ToggleGroup
          type="single"
          value={mode}
          spacing={0.25}
          className="bg-accent rounded-md p-0.5"
        >
          <ToggleGroupItem
            value="summary"
            size="sm"
            className={SEG}
            onClick={() => surface.setReviewMode('summary')}
          >
            Summary
          </ToggleGroupItem>
          <ToggleGroupItem
            value="full"
            size="sm"
            className={SEG}
            onClick={() => surface.setReviewMode('full')}
          >
            Full diff
            <Kbd className="bg-transparent max-[700px]:hidden">F</Kbd>
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="flex-1" />
        <span className={cn(SUB, 'shrink-[99]')}>{title}</span>
        {h.diff && (
          <span className={cn(SUB, 'flex-none tabular-nums')}>
            {filesWord(h.diff.files.length)} ·{' '}
            <span className="text-status-running">+{nf(h.diff.add)}</span>{' '}
            <span className="text-status-error">−{nf(h.diff.del)}</span>
          </span>
        )}
        {isHttp(result.ref) && (
          <Button
            variant="outline"
            size="sm"
            className={cn(BTN, 'ml-3')}
            onClick={() => surface.openExternal(result.ref)}
          >
            Open on GitHub
          </Button>
        )}
        {thread && !thread.done && (
          <Button
            size="sm"
            className={cn(BTN, 'ml-2')}
            onClick={() => {
              // A21: done without leaving the review first; lands on the thread.
              surface.done(thread.id, { stay: true })
              surface.closeResult()
            }}
          >
            Done
            <Kbd className="bg-primary-foreground/20 text-primary-foreground/80 ml-0.5 max-[1100px]:hidden">
              E
            </Kbd>
          </Button>
        )}
      </Head>
      {mode === 'full'
        ? files && <Full parts={parts} resultId={result.id} />
        : // Nothing until it is known whether the agent wrote a summary.
          h.review !== undefined && (
            <Summary
              review={h.review}
              parts={parts}
              loading={!h.diff && !h.failed}
              failed={h.failed}
              title={title}
              heading={
                typeof result.meta?.title === 'string'
                  ? result.meta.title
                  : title
              }
              resultId={result.id}
              toFull={(file) => {
                if (file) placeOf(result.id).file = file
                surface.setReviewMode('full')
              }}
            />
          )}
    </>
  )
}

// S10: the running page with its address.
function Site({ result }: { result: ResultRow }) {
  const surface = useSurface()
  const thread = useThread(result.sessionId)
  const ok = isHttp(result.ref)
  const [, scheme, rest] = /^(https?:\/\/)?(.*)$/.exec(result.ref)!
  return (
    <>
      <Head back={thread?.title}>
        <span className="flex-1" />
        <div className="bg-accent text-muted-foreground [&_svg]:text-faint text-meta flex h-7 min-w-[180px] flex-[0_1_340px] items-center gap-2 rounded-md px-3 [&_svg]:flex-none">
          {I.globe}
          <span className="text-foreground truncate select-text">
            <i className="text-faint not-italic">{scheme}</i>
            {rest}
          </span>
        </div>
        <span className="flex-1" />
        {ok && (
          <Button
            variant="outline"
            size="sm"
            className={cn(BTN, 'ml-3')}
            onClick={() => surface.openExternal(result.ref)}
          >
            Open in browser
          </Button>
        )}
      </Head>
      {ok && surface.host.platform === 'web' && (
        <iframe
          className="min-h-0 w-full flex-1 border-0 bg-white"
          src={result.ref}
          title={resultTitle(result)}
        />
      )}
    </>
  )
}

export default function Review({ resultId }: { resultId: string }) {
  const result = useS((s) => s.rows.result.get(resultId))
  return (
    <div
      id="review"
      className="bg-background animate-in fade-in-0 slide-in-from-bottom-1 absolute inset-0 z-[5] flex flex-col duration-200"
      data-pane="review"
    >
      {!result ? (
        <Head back={undefined} />
      ) : result.type === 'preview' ? (
        <Site result={result} />
      ) : (
        <Changes result={result} key={result.id} />
      )}
    </div>
  )
}
