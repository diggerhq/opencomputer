import { useEffect } from 'react'
import { useS, useSurface } from '../hooks'
import { I } from './bits'
import './review.css'

// The newest thing said; what can be undone says so (Z).
export function Toasts() {
  const surface = useSurface()
  const t = useS((s) => s.toasts[s.toasts.length - 1])
  if (!t) return null
  const undo = t.undo
  return (
    <div className={t.tone === 'error' ? 'toast on err' : 'toast on'} role="status">
      {undo && I.check}
      <span>{t.text}</span>
      {undo && (
        <button
          onClick={() => {
            undo()
            surface.dismissToast(t.id)
          }}
        >
          Undo<kbd>Z</kbd>
        </button>
      )}
    </div>
  )
}

// Spec section 12.
const KEYS: [string, string[]][] = [
  ['Move in the list', ['J', 'K']],
  ['New', ['N']],
  ['Start from anywhere', ['⌘K']],
  ['Reply', ['R']],
  ['Done', ['E']],
  ['Undo', ['Z']],
  ['Track it', ['T']],
  ['Review changes', ['Space']],
  ['Summary or full diff, in a review', ['F']],
  ['Layout', ['1', '2', '3']],
  ['Hide or show the list', ['[']],
  ['Close one layer', ['Esc']],
  ['This sheet', ['?']],
]

export function KeysSheet() {
  const surface = useSurface()
  const on = useS((s) => s.keysSheet)
  useEffect(() => {
    if (!on) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // This layer only (R19).
      e.preventDefault()
      e.stopPropagation()
      surface.setKeysSheet(false)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [surface, on])
  if (!on) return null
  return (
    <>
      <div className="scrim on" role="presentation" onClick={() => surface.setKeysSheet(false)} />
      <div className="help on" role="dialog" aria-label="Shortcuts">
        <h3>Shortcuts</h3>
        <dl>
          {KEYS.map(([what, keys]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  )
}
