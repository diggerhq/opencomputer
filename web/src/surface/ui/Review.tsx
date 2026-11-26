import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ResultRow, Review as Written } from '@opencomputer/sdk/computer'
import { useS, useSurface, useThread } from '../hooks'
import { I, Mk, Rich, resultTitle } from './bits'
import './review.css'

// ---- the diff as GitHub sends it ----

interface Line {
  // '~' is the gap before a hunk.
  t: ' ' | '+' | '-' | '~'
  old: number | null
  new: number | null
  s: string
}

interface DiffFile {
  path: string
  tag: string
  add: number
  del: number
  lines: Line[]
  // Exact, as rows have a fixed height: nothing moves when a file draws late.
  height: number
}

function parseDiff(text: string): { files: DiffFile[]; add: number; del: number } {
  const files: DiffFile[] = []
  let f: DiffFile | null = null
  let o = 0
  let n = 0
  // Lines the open hunk still owes, so a removed line "-- x" is not read as a header.
  let left = 0
  let right = 0
  for (const raw of text.split('\n')) {
    if (f && (left > 0 || right > 0)) {
      const c = raw[0] ?? ' '
      if (c === '\\') continue
      if (c === '+') {
        f.lines.push({ t: '+', old: null, new: n++, s: raw.slice(1) })
        f.add++
        right--
        continue
      }
      if (c === '-') {
        f.lines.push({ t: '-', old: o++, new: null, s: raw.slice(1) })
        f.del++
        left--
        continue
      }
      if (c === ' ') {
        f.lines.push({ t: ' ', old: o++, new: n++, s: raw.slice(1) })
        left--
        right--
        continue
      }
      left = right = 0
    }
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(raw)
    if (head) {
      f = { path: head[2], tag: '', add: 0, del: 0, lines: [], height: 0 }
      files.push(f)
      continue
    }
    if (!f) continue
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(raw)
    if (hunk) {
      o = +hunk[1]
      n = +hunk[3]
      left = hunk[2] === undefined ? 1 : +hunk[2]
      right = hunk[4] === undefined ? 1 : +hunk[4]
      f.lines.push({ t: '~', old: null, new: null, s: hunk[5] })
    } else if (raw.startsWith('new file mode')) f.tag = 'new file'
    else if (raw.startsWith('deleted file mode')) f.tag = 'deleted'
    else if (raw.startsWith('rename to ')) {
      f.path = raw.slice(10)
      f.tag = 'renamed'
    } else if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) f.tag ||= 'binary'
    else if (raw.startsWith('+++ b/')) f.path = raw.slice(6)
  }
  let add = 0
  let del = 0
  for (const x of files) {
    const gaps = x.lines.reduce((k, l) => k + (l.t === '~' ? 1 : 0), 0)
    x.height = (x.lines.length - gaps) * 22 + gaps * 32 + 8
    add += x.add
    del += x.del
  }
  return { files, add, del }
}

// ---- what is held, so reopening is instant ----

interface Held {
  // null: the agent has not written one.
  review?: Written | null
  text?: string
  diff?: ReturnType<typeof parseDiff>
}
const held = new Map<string, Held>()

function useHeld(resultId: string): Held {
  const surface = useSurface()
  const [h, setH] = useState<Held>(() => held.get(resultId) ?? {})
  useEffect(() => {
    let live = true
    const put = (p: Partial<Held>) => {
      const next = { ...held.get(resultId), ...p }
      held.set(resultId, next)
      if (live) setH(next)
    }
    surface.review(resultId).then(
      (review) => put({ review }),
      () => {
        if (held.get(resultId)?.review === undefined) put({ review: null })
      },
    )
    surface.diff(resultId).then(
      (text) => {
        if (held.get(resultId)?.text !== text) put({ text, diff: parseDiff(text) })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [surface, resultId])
  return h
}

// ---- parts: the agent's reading order over the files of the diff ----

interface Part {
  title: string
  note: string | null
  eye: boolean
  // How many files the agent listed, for before the diff arrives.
  listed: number
  files: DiffFile[]
  add: number
  del: number
}

function group(review: Written | null | undefined, files: DiffFile[] | undefined): Part[] {
  const byPath = new Map((files ?? []).map((f) => [f.path, f]))
  const parts: Part[] = (review?.parts ?? []).map((p) => {
    const own: DiffFile[] = []
    for (const path of p.files) {
      const f = byPath.get(path)
      if (!f) continue
      // A file named in two parts is read in the first.
      byPath.delete(path)
      own.push(f)
    }
    return { title: p.title, note: p.note, eye: p.weight === 'eye', listed: p.files.length, files: own, add: 0, del: 0 }
  })
  if (byPath.size)
    parts.push({ title: parts.length ? 'Everything else' : '', note: null, eye: false, listed: byPath.size, files: [...byPath.values()], add: 0, del: 0 })
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

function Pm({ add, del }: { add: number; del: number }) {
  return (
    <>
      <span className={add ? 'a' : 'a z'}>+{nf(add)}</span>
      <span className={del ? 'd' : 'd z'}>−{nf(del)}</span>
    </>
  )
}

const row = (l: Line, i: number) =>
  l.t === '~' ? (
    <div className="gap" key={i}>
      <span>⋯ {l.s}</span>
    </div>
  ) : (
    <div className={l.t === '+' ? 'dl a' : l.t === '-' ? 'dl d' : 'dl'} key={i}>
      <i>{l.new ?? l.old}</i>
      <u>{l.t}</u>
      {l.s}
    </div>
  )

// A file's rows exist only while it is near the viewport (R41).
const FileCard = memo(function FileCard({ file }: { file: DiffFile }) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current!
    const io = new IntersectionObserver((es) => setNear(es[es.length - 1].isIntersecting), {
      root: el.closest('.rvc, .rvr'),
      rootMargin: '1200px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div className="fc" data-path={file.path} ref={ref}>
      <div className="fh">
        <span className="nm">
          {'‎'}
          {file.path}
        </span>
        {file.tag && <span className="tag">{file.tag}</span>}
        <Pm add={file.add} del={file.del} />
      </div>
      <div className="body" style={{ height: file.height }}>
        {near && file.lines.map(row)}
      </div>
    </div>
  )
})

// ---- Summary ----

function Summary({
  review,
  parts,
  title,
  heading,
  resultId,
  open,
  toggle,
  toFull,
}: {
  review: Written | null
  parts: Part[]
  title: string
  heading: string
  resultId: string
  open: ReadonlySet<number>
  toggle: (i: number) => void
  toFull: (file?: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [cur, setCur] = useState(0)
  const named = parts.length > 0 && parts[0].title !== ''
  const max = Math.max(1, ...parts.map((p) => p.add + p.del))
  const eyes = parts.map((p, i) => ({ p, i })).filter((x) => x.p.eye)

  const secs = () => [...scroller.current!.querySelectorAll<HTMLElement>('.pt')]
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
    <div className="rv">
      {named && (
        <div className="rvo">
          {parts.map((p, i) => (
            <button className={i === cur ? 'op on' : 'op'} key={i} onClick={() => go(i)}>
              <span className="on-n">{i + 1}</span>
              <span className="n">
                {p.title}
                {p.eye && <> <Mk mark="blocked" className="sm" /></>}
                <span className="bar">
                  {p.add > 0 && <i style={{ width: `${Math.max(3, (p.add / max) * 100)}%` }} />}
                  {p.del > 0 && <b style={{ width: `${Math.max(3, (p.del / max) * 100)}%` }} />}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="rvr" ref={scroller} onScroll={act}>
        <article>
          {review ? (
            <h2>
              <Rich text={heading} />
            </h2>
          ) : (
            <p className="none">The agent has not written a summary of this change. These are the files it touches.</p>
          )}
          {eyes.length > 0 && (
            <div className="blk ask" style={{ maxWidth: 'none', margin: '0 0 8px' }}>
              <b style={{ fontWeight: 650 }}>{eyes.length === 1 ? 'One thing' : `${eyes.length} things`} worth your eye</b>
              {eyes.map(({ p, i }) => (
                <button className="lk" key={i} onClick={() => go(i)}>
                  <Mk mark="blocked" className="sm" />
                  <span>{p.title}</span>
                </button>
              ))}
            </div>
          )}
          {named
            ? parts.map((p, i) => (
                <section className="pt" key={i}>
                  <div className="ph">
                    <span className="on-n">{i + 1}</span>
                    <h3>{p.title}</h3>
                    {p.eye && <span className="eye">worth your eye</span>}
                  </div>
                  <div className="pm">
                    {filesWord(p.files.length || p.listed)}
                    {p.files.length > 0 && (
                      <>
                        {' · '}
                        <span style={{ color: 'var(--addt)' }}>+{nf(p.add)}</span>{' '}
                        <span style={{ color: 'var(--delt)' }}>−{nf(p.del)}</span>
                      </>
                    )}
                  </div>
                  {p.note && (
                    <div className="pn">
                      <Rich text={p.note} />
                    </div>
                  )}
                  {p.files.length > 0 && (
                    <button className={open.has(i) ? 'more open' : 'more'} onClick={() => toggle(i)}>
                      {I.chev}
                      {open.has(i) ? 'Hide' : 'Show'} the full diff of this part · {filesWord(p.files.length)}
                    </button>
                  )}
                  {open.has(i) && (
                    <div className="exp">
                      {p.files.map((f) => (
                        <FileCard file={f} key={f.path} />
                      ))}
                    </div>
                  )}
                </section>
              ))
            : parts.map((p) =>
                p.files.map((f) => (
                  <button className="rfl" key={f.path} onClick={() => toFull(f.path)}>
                    <span>
                      {'‎'}
                      {f.path}
                    </span>
                    <Pm add={f.add} del={f.del} />
                  </button>
                )),
              )}
          {parts.some((p) => p.files.length > 0) && (
            <p className="end">
              That is everything in {title}. <button onClick={() => toFull()}>Read the full diff</button> if you want every line.
            </p>
          )}
        </article>
      </div>
    </div>
  )
}

// ---- Full diff ----

function Full({ parts, resultId }: { parts: Part[]; resultId: string }) {
  const code = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [seen, setCur] = useState<string | null>(null)
  const cur = seen ?? placeOf(resultId).file ?? parts.find((p) => p.files.length)?.files[0].path ?? null
  const partOf = useMemo(() => new Map(parts.flatMap((p, i) => p.files.map((f) => [f.path, i] as const))), [parts])

  const card = (path: string) => code.current!.querySelector<HTMLElement>(`.fc[data-path="${CSS.escape(path)}"]`)
  const act = () => {
    const c = code.current!
    let a: HTMLElement | null = null
    for (const el of c.querySelectorAll<HTMLElement>('.fc')) {
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
    const el = p.file ? card(p.file) : p.part ? code.current!.querySelector<HTMLElement>(`[data-part="${p.part}"]`) : null
    if (el) code.current!.scrollTop = el.offsetTop - 16
    // Only on arriving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The list follows the code, unless the reader is in the list.
  useEffect(() => {
    const l = list.current!
    const item = l.querySelector<HTMLElement>('.fs.on')
    if (item && !l.matches(':hover')) l.scrollTop = item.offsetTop - l.clientHeight / 3
  }, [cur])

  return (
    <div className="rv">
      <div className="rvs" ref={list}>
        {parts.map((p, i) => (
          <div className="gp" key={i}>
            {p.title && (
              <div className="gh">
                <span className="on-n">{i + 1}</span>
                {p.title}
              </div>
            )}
            {p.files.map((f) => (
              <button className={f.path === cur ? 'fs on' : 'fs'} key={f.path} onClick={() => go(f.path)}>
                <span className="p">
                  <span>
                    {'‎'}
                    {f.path}
                  </span>
                  <Pm add={f.add} del={f.del} />
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="rvc" ref={code} onScroll={act}>
        {parts.map((p, i) => [
          p.title && (
            <div className="gh2" data-part={i} key={`h${i}`}>
              {i + 1} · {p.title}
            </div>
          ),
          p.title && p.note && (
            <div className="gs" key={`n${i}`}>
              <Rich text={p.note} />
            </div>
          ),
          p.files.map((f) => <FileCard file={f} key={f.path} />),
        ])}
      </div>
    </div>
  )
}

// ---- the header: one way back, also Escape (R19) ----

function Head({ back, children }: { back: string | undefined; children?: ReactNode }) {
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
    <div className="hd">
      <button className="pill back" onClick={() => surface.closeResult()}>
        {I.back}
        <span>{back ?? 'Back'}</span>
        <kbd>Esc</kbd>
      </button>
      {children}
    </div>
  )
}

const isHttp = (ref: string) => /^https?:\/\//.test(ref)

function Changes({ result }: { result: ResultRow }) {
  const surface = useSurface()
  const thread = useThread(result.sessionId)
  const mode = useS((s) => s.reviewMode)
  const h = useHeld(result.id)
  const files = h.diff?.files
  const parts = useMemo(() => group(h.review, files), [h.review, files])
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  const title = resultTitle(result)

  return (
    <>
      <Head back={thread?.title}>
        <span className="sp" />
        <div className="seg2">
          <button className={mode === 'summary' ? 'on' : ''} onClick={() => surface.setReviewMode('summary')}>
            Summary
          </button>
          <button className={mode === 'full' ? 'on' : ''} onClick={() => surface.setReviewMode('full')}>
            Full diff<kbd>F</kbd>
          </button>
        </div>
        <span className="sp" />
        <span className="sub" style={{ flexShrink: 99 }}>
          {title}
        </span>
        {h.diff && (
          <span className="sub tot">
            {filesWord(h.diff.files.length)} · <span className="a">+{nf(h.diff.add)}</span> <span className="d">−{nf(h.diff.del)}</span>
          </span>
        )}
        {isHttp(result.ref) && (
          <button className="btn" style={{ marginLeft: 12 }} onClick={() => surface.openExternal(result.ref)}>
            Open on GitHub
          </button>
        )}
        {thread && !thread.done && (
          <button
            className="btn p"
            style={{ marginLeft: 8 }}
            onClick={() => {
              // A21: done without leaving the review first; lands on the thread.
              surface.done(thread.id, { stay: true })
              surface.closeResult()
            }}
          >
            Done<kbd>E</kbd>
          </button>
        )}
      </Head>
      {mode === 'full' ? (
        files && <Full parts={parts} resultId={result.id} />
      ) : (
        // Nothing until it is known whether the agent wrote a summary.
        h.review !== undefined && (
          <Summary
            review={h.review}
            parts={parts}
            title={title}
            heading={typeof result.meta?.title === 'string' ? result.meta.title : title}
            resultId={result.id}
            open={open}
            toggle={(i) => {
              const next = new Set(open)
              if (!next.delete(i)) next.add(i)
              setOpen(next)
            }}
            toFull={(file) => {
              if (file) placeOf(result.id).file = file
              surface.setReviewMode('full')
            }}
          />
        )
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
        <span className="sp" />
        <div className="url">
          {I.globe}
          <span>
            <i>{scheme}</i>
            {rest}
          </span>
        </div>
        <span className="sp" />
        {ok && (
          <button className="btn" style={{ marginLeft: 12 }} onClick={() => surface.openExternal(result.ref)}>
            Open in browser
          </button>
        )}
      </Head>
      {ok && surface.host.platform === 'web' && <iframe className="site-frame" src={result.ref} title={resultTitle(result)} />}
    </>
  )
}

export default function Review({ resultId }: { resultId: string }) {
  const result = useS((s) => s.rows.result.get(resultId))
  return (
    <div id="review" className="on" data-pane="review">
      {!result ? <Head back={undefined} /> : result.type === 'preview' ? <Site result={result} /> : <Changes result={result} key={result.id} />}
    </div>
  )
}
