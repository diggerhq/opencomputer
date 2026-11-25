import { tinykeys } from 'tinykeys'
import type { Surface } from '../store'

// Spec section 12: one key per frequent action. Letters act only while the
// person is not typing; Escape always closes one layer.

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)
}

export function bindKeys(root: HTMLElement, surface: Surface): () => void {
  const plain = (fn: (e: KeyboardEvent) => void) => (e: KeyboardEvent) => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
    const s = surface.get()
    if (s.palette || s.keysSheet) return
    e.preventDefault()
    fn(e)
  }
  const openThread = () => {
    const sid = surface.get().loc.thread
    return sid ? surface.thread(sid) : undefined
  }
  const move = (by: number) => {
    const rows = [...root.querySelectorAll<HTMLElement>('.list [data-nav]')]
    if (!rows.length) return
    const at = rows.findIndex((r) => r.classList.contains('sel'))
    const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? (by > 0 ? 0 : rows.length - 1) : at + by))]
    next.click()
    next.scrollIntoView({ block: 'nearest' })
  }
  const review = () => {
    const t = openThread()
    const r = t?.results.find((x) => x.type === 'pr' || x.type === 'changes')
    if (r) surface.openResult(r)
  }
  const layout = (l: 'L1' | 'L2' | 'L3') => {
    const t = openThread()
    if (t?.trackId) surface.setLayout(t.trackId, l)
  }
  return tinykeys(window, {
    j: plain(() => move(1)),
    k: plain(() => move(-1)),
    n: plain(() => surface.openStart()),
    '$mod+k': (e) => {
      e.preventDefault()
      surface.setPalette(!surface.get().palette)
    },
    r: plain(() => {
      const s = surface.get()
      const key = s.loc.thread ? `t:${s.loc.thread}` : s.loc.track ? `k:${s.loc.track}` : 'new'
      root.querySelector<HTMLTextAreaElement>(`textarea[data-draft="${key}"]`)?.focus()
    }),
    e: plain(() => {
      const s = surface.get()
      const t = openThread()
      if (!t || t.done) return
      const p = t.proposals.find((x) => x.type === 'done')
      if (p) surface.accept(p.id)
      else surface.done(t.id, s.loc.result ? { stay: true } : undefined)
      if (s.loc.result) surface.closeResult()
    }),
    z: plain(() => void surface.undoLast()),
    t: plain(() => {
      const t = openThread()
      if (t && !t.trackId && !t.done) surface.trackIt(t.id)
    }),
    Space: plain(() => {
      if (surface.get().loc.result) surface.closeResult()
      else review()
    }),
    f: plain(() => {
      const s = surface.get()
      if (s.loc.result) surface.setReviewMode(s.reviewMode === 'full' ? 'summary' : 'full')
    }),
    '1': plain(() => layout('L1')),
    '2': plain(() => layout('L2')),
    '3': plain(() => layout('L3')),
    '[': plain(() => surface.toggleList()),
    'Shift+?': plain(() => surface.setKeysSheet(true)),
    Escape: (e) => {
      const s = surface.get()
      if (s.keysSheet) return surface.setKeysSheet(false)
      if (s.palette) return surface.setPalette(false)
      if (root.querySelector('.menu.on')) return
      if (typing(e)) return (e.target as HTMLElement).blur()
      if (s.loc.result) return surface.closeResult()
    },
  })
}
