import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ResultRow } from '@opencomputer/sdk/computer'
import { useS, useSurface } from '../hooks'
import type { Mark } from '../store/views'

// Small pieces every pane uses. Markup and class names follow the prototype
// (product/tracks-and-threads/prototype), whose stylesheet is surface.css.

const svg = (d: ReactNode, o: { w?: number; vb?: number; fill?: boolean; sw?: number } = {}) => (
  <svg
    width={o.w ?? 14}
    height={o.w ?? 14}
    viewBox={`0 0 ${o.vb ?? 16} ${o.vb ?? 16}`}
    fill={o.fill ? 'currentColor' : 'none'}
    stroke={o.fill ? undefined : 'currentColor'}
    strokeWidth={o.sw ?? 1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {d}
  </svg>
)

export const I = {
  pr: svg(<><circle cx="4.2" cy="3.8" r="1.6" /><circle cx="4.2" cy="12.2" r="1.6" /><circle cx="11.8" cy="12.2" r="1.6" /><path d="M4.2 5.4v5.2M11.8 10.6V7a2.2 2.2 0 0 0-2.2-2.2H8M9.4 3.2L7.8 4.8l1.6 1.6" /></>),
  files: svg(<><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></>),
  globe: svg(<><circle cx="8" cy="8" r="5.6" /><path d="M2.4 8h11.2M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2" /></>),
  doc: svg(<><path d="M4 2.5h8v11H4z" /><path d="M6.2 5.6h3.6M6.2 8h3.6M6.2 10.4h2" /></>),
  chev: svg(<path d="M2.2 3.6L5 6.4l2.8-2.8" />, { w: 10, vb: 10, sw: 1.6 }),
  track: svg(<><rect x="2.2" y="2.5" width="11.6" height="4" rx="1.4" /><path d="M5 9.5h8.8M5 13h8.8M2.4 9.5h.1M2.4 13h.1" /></>),
  dots: svg(<><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></>, { w: 16, fill: true }),
  stop: svg(<rect x="1.5" y="1.5" width="7" height="7" rx="1.5" />, { w: 10, vb: 10, fill: true }),
  check: svg(<path d="M2.8 7.4l2.8 2.8 5.6-6" />, { w: 13, vb: 14, sw: 1.7 }),
  clock: svg(<><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.1 1.4" /></>),
  up: svg(<path d="M7 11.5v-9M3.2 6.2L7 2.4l3.8 3.8" />, { vb: 14, sw: 1.8 }),
  back: svg(<path d="M13 8H3.2M7 4L3 8l4 4" />),
  side: svg(<><rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2.3" /><path d="M6 3v10" /></>, { w: 16 }),
  compose: svg(<><path d="M7 2.8H4.3A1.8 1.8 0 0 0 2.5 4.6v7.1a1.8 1.8 0 0 0 1.8 1.8h7.1a1.8 1.8 0 0 0 1.8-1.8V9" /><path d="M12.2 2.3a1.1 1.1 0 0 1 1.5 1.5L8.6 8.9l-2 .5.5-2z" /></>, { w: 15 }),
  theme: svg(<><circle cx="8" cy="8" r="5.3" /><path d="M8 2.7v10.6A5.3 5.3 0 0 0 8 2.7z" fill="currentColor" /></>, { w: 15 }),
  help: svg(<><circle cx="8" cy="8" r="5.8" /><path d="M6.4 6.5a1.7 1.7 0 1 1 2.4 1.6c-.5.3-.8.6-.8 1.1M8 11.3v.1" /></>, { w: 15 }),
  lay: (inner: ReactNode) => svg(<><rect x="1.7" y="3.2" width="12.6" height="9.6" rx="2" />{inner}</>, { w: 16 }),
}

// The mark of spec section 3: dot (blocked), ring (ready), spinner (working).
export function Mk({ mark, className = '' }: { mark: Mark; className?: string }) {
  return <span className={`mk ${mark ?? ''} ${className}`} />
}

const ICON: Record<string, ReactNode> = { pr: I.pr, changes: I.files, preview: I.globe, file: I.doc, document: I.doc }

// A result's icon; the ring instead while it is what the thread waits on (R20).
export function ResultIcon({ result, ring }: { result: ResultRow; ring?: boolean }) {
  return ring ? (
    <span className="ri">
      <Mk mark="ready" />
    </span>
  ) : (
    <>{ICON[result.type] ?? I.doc}</>
  )
}

export function resultTitle(r: ResultRow): string {
  if (r.title) return r.title
  const pr = r.type === 'pr' ? /\/pull\/(\d+)/.exec(r.ref) : null
  return pr ? `PR #${pr[1]}` : (r.ref.split('/').pop() ?? r.ref)
}

// "open · checks passed", "+11,486 −493", "running".
export function resultDetail(r: ResultRow): string {
  const m = r.meta ?? {}
  if (typeof m.detail === 'string') return m.detail
  const parts: string[] = []
  if (r.state) parts.push(r.state)
  if (r.type === 'pr' && typeof m.checks === 'string') parts.push(`checks ${m.checks}`)
  if (typeof m.additions === 'number' && typeof m.deletions === 'number')
    parts.push(`+${m.additions.toLocaleString()} −${m.deletions.toLocaleString()}`)
  return parts.join(' · ')
}

// ---- text ----

const inline = (s: string, k: number): ReactNode[] => {
  const out: ReactNode[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|(https?:\/\/[^\s)]+)|(?<![\w*_])[_*]([^_*\n]+)[_*](?![\w*_])/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const key = `${k}-${m.index}`
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>)
    else if (m[2] !== undefined) out.push(<b key={key}>{m[2]}</b>)
    else if (m[6] !== undefined) out.push(<em key={key}>{m[6]}</em>)
    else
      out.push(
        <a key={key} href={m[4] ?? m[5]} target="_blank" rel="noreferrer">
          {m[3] ?? m[5]}
        </a>,
      )
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

// Markdown as the agents write it: paragraphs, lists, headings, fenced code,
// inline code, bold and links. Half-arrived text draws as far as it has come.
export const Rich = memo(function Rich({ text }: { text: string }) {
  if (!text.includes('\n')) return <>{inline(text, 0)}</>
  const out: ReactNode[] = []
  text.split(/```\w*\n?/).forEach((seg, i) => {
    if (i % 2) return out.push(<pre key={i} className="cb">{seg.replace(/\n$/, '')}</pre>)
    seg
      .trim()
      .replace(/^(?![-*] |\d+\. )(.+)\n(?=[-*] |1\. )/gm, '$1\n\n')
      .split(/\n\n+/)
      .filter(Boolean)
      .forEach((b, j) => {
        const key = `${i}-${j}`
        const h = /^(#{1,3}) (.*)$/.exec(b)
        if (h && !b.includes('\n')) out.push(h[1].length === 1 ? <h2 key={key}>{inline(h[2], j)}</h2> : <h3 key={key}>{inline(h[2], j)}</h3>)
        else if (/^[-*] /.test(b))
          out.push(
            <ul key={key}>
              {b.split('\n').map((l, n) => (
                <li key={n}>{inline(l.replace(/^[-*] /, ''), n)}</li>
              ))}
            </ul>,
          )
        else if (/^\d+\. /.test(b))
          out.push(
            <ol key={key}>
              {b.split('\n').map((l, n) => (
                <li key={n}>{inline(l.replace(/^\d+\. /, ''), n)}</li>
              ))}
            </ol>,
          )
        else
          out.push(
            <p key={key}>
              {b.split('\n').flatMap((l, n) => (n ? [<br key={`b${n}`} />, ...inline(l, n)] : inline(l, n)))}
            </p>,
          )
      })
  })
  return <>{out}</>
})

// ---- the composer: a plain growing textarea whose draft is kept (R44) ----

export function Composer({
  draftKey,
  placeholder,
  onSend,
  autoFocus,
  rows = 1,
}: {
  draftKey: string
  placeholder: string
  onSend(text: string, e: { meta: boolean }): void
  autoFocus?: boolean
  rows?: number
}) {
  const surface = useSurface()
  const text = useS((s) => s.drafts[draftKey] ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || rows > 1) return
    el.style.height = '34px'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text, rows])
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus, draftKey])
  const send = (meta: boolean) => {
    const t = text.trim()
    if (!t) return
    surface.setDraft(draftKey, '')
    onSend(t, { meta })
  }
  return (
    <div className="comp">
      <textarea
        ref={ref}
        data-draft={draftKey}
        placeholder={placeholder}
        rows={rows}
        value={text}
        onChange={(e) => surface.setDraft(draftKey, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send(e.metaKey || e.ctrlKey)
          } else if (e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      <button className={`send ${text.trim() ? 'rdy' : ''}`} aria-label="Send" title="Send (Enter)" onClick={() => send(false)}>
        {I.up}
      </button>
    </div>
  )
}

// ---- a menu at a button (S6, S7) ----

export type MenuItem = { label: string; onSelect?(): void; danger?: boolean; items?: MenuItem[] } | 'sep'

export function MenuButton({ items, label = 'More' }: { items: () => MenuItem[]; label?: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const [sub, setSub] = useState<MenuItem[] | null>(null)
  useEffect(() => {
    if (!at) return
    const close = () => (setAt(null), setSub(null))
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', key, true)
    }
  }, [at])
  return (
    <>
      <button
        className="ib r"
        aria-label={label}
        data-tip={label}
        onClick={(e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          setSub(null)
          setAt(at ? null : { x: Math.max(8, r.right - 200), y: r.bottom + 4 })
        }}
      >
        {I.dots}
      </button>
      {at && (
        <div className="menu on" role="menu" style={{ left: at.x, top: at.y }}>
          {(sub ?? items()).map((it, i) =>
            it === 'sep' ? (
              <hr key={i} />
            ) : (
              <button
                key={i}
                role="menuitem"
                className={it.danger ? 'd' : ''}
                onClick={(e) => {
                  if (it.items) {
                    e.stopPropagation()
                    setSub(it.items)
                  } else it.onSelect?.()
                }}
              >
                {it.label}
                {it.items ? ' ▸' : ''}
              </button>
            ),
          )}
        </div>
      )}
    </>
  )
}

export const when = (iso: string | number | null | undefined, now = Date.now()): string => {
  if (!iso) return ''
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime()
  const d = new Date(t)
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000)
  if (days <= 0) return 'today'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
