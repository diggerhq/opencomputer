import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type CodeTab } from '@/components/code-off-ramp'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { cn } from '@/lib/utils'

export type GuideStep = {
  /** The real UI element this step points at (spotlighted). */
  target: React.RefObject<HTMLElement | null>
  title: string
  body: string
  /** The API call that produced this region, e.g. "POST /v3/sessions". */
  api?: string
  /** Tabbed, copyable snippets of the real call (SDK / CLI / API). */
  code?: CodeTab[]
  docs?: string
}

const CALLOUT_W = 520
const PAD = 8
const M = 16 // viewport margin
const GAP = 12 // gap between spotlight and callout

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(v, hi))

/**
 * A first-run guided overlay: spotlights real UI regions on the destination view
 * and, beside each, explains what it is + the exact public API call that
 * produced it, with SDK / CLI / API tabs so people can jump to the path they
 * care about. Non-blocking (the page behind stays usable); resize/scroll-safe.
 */
export function GuidedTour({
  steps,
  open,
  onClose,
}: {
  steps: GuideStep[]
  open: boolean
  onClose: () => void
}) {
  const [i, setI] = useState(0)
  const [tab, setTab] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [copied, markCopied] = useTransientFlag(1500)
  const calloutRef = useRef<HTMLDivElement>(null)
  const [calloutH, setCalloutH] = useState(360)

  useEffect(() => {
    if (open) {
      setI(0)
      setTab(0)
    }
  }, [open])

  // Reset the code tab whenever the step changes.
  useEffect(() => {
    setTab(0)
  }, [i])

  // Measure the callout's real height so placement can avoid overlapping the
  // spotlight (a fixed estimate misplaces short/tall callouts).
  useLayoutEffect(() => {
    if (calloutRef.current) setCalloutH(calloutRef.current.offsetHeight)
  }, [open, i, tab, rect])

  const step = steps[i]

  // Measure the current target, scroll it into view, and keep the spotlight
  // pinned to it through the smooth-scroll settle + any resize/scroll.
  useLayoutEffect(() => {
    if (!open || !step) return
    const measure = () => {
      const el = step.target.current
      if (el) setRect(el.getBoundingClientRect())
    }
    step.target.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    measure()
    const timers = [setTimeout(measure, 150), setTimeout(measure, 450)]
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      timers.forEach(clearTimeout)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, i, step])

  // Esc closes; arrows navigate.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && i < steps.length - 1) setI((n) => n + 1)
      else if (e.key === 'ArrowLeft' && i > 0) setI((n) => n - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, i, steps.length, onClose])

  if (!open || !step) return null

  const spot = rect
    ? {
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : null

  // Place the callout in whichever region around the spotlight has real room —
  // below → above → right → left — so it never sits on top of the target. If the
  // target is too big to clear (full-width, tall panels), dock it to the right
  // edge (guaranteed on-screen).
  const vw = window.innerWidth
  const vh = window.innerHeight
  let calloutTop = M
  let calloutLeft = M
  if (spot) {
    const roomBelow = vh - (spot.top + spot.height)
    const roomAbove = spot.top
    const roomRight = vw - (spot.left + spot.width)
    const roomLeft = spot.left
    if (roomBelow >= calloutH + GAP + M) {
      calloutTop = spot.top + spot.height + GAP
      calloutLeft = clamp(spot.left, M, vw - CALLOUT_W - M)
    } else if (roomAbove >= calloutH + GAP + M) {
      calloutTop = spot.top - calloutH - GAP
      calloutLeft = clamp(spot.left, M, vw - CALLOUT_W - M)
    } else if (roomRight >= CALLOUT_W + GAP + M) {
      calloutLeft = spot.left + spot.width + GAP
      calloutTop = clamp(spot.top, M, vh - calloutH - M)
    } else if (roomLeft >= CALLOUT_W + GAP + M) {
      calloutLeft = spot.left - CALLOUT_W - GAP
      calloutTop = clamp(spot.top, M, vh - calloutH - M)
    } else {
      calloutLeft = vw - CALLOUT_W - M
      calloutTop = clamp(vh / 2 - calloutH / 2, M, vh - calloutH - M)
    }
  }

  const tabs = step.code ?? []
  const current = tabs[tab] ?? tabs[0]
  const copy = () => {
    if (current) void navigator.clipboard.writeText(current.code).then(markCopied)
  }

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="false">
      {/* Spotlight: a ring around the target with a huge box-shadow scrim so
          everything else dims. pointer-events-none → the page stays usable. */}
      {spot ? (
        <div
          className="ring-primary pointer-events-none absolute rounded-lg ring-2 transition-all duration-200"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/55" />
      )}

      {/* Callout */}
      <div
        ref={calloutRef}
        className="bg-background absolute rounded-lg border p-4 shadow-xl"
        style={{
          top: calloutTop,
          left: calloutLeft,
          width: CALLOUT_W,
          maxWidth: 'calc(100vw - 32px)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground text-xs">
            Step {i + 1} of {steps.length}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground -mt-1 -mr-1"
          >
            <X className="size-4" />
          </button>
        </div>

        <h3 className="text-foreground mt-1 text-sm font-semibold">
          {step.title}
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">{step.body}</p>

        {step.api ? (
          <div className="text-muted-foreground mt-2 font-mono text-xs">
            {step.api}
          </div>
        ) : null}

        {tabs.length > 0 ? (
          <div className="bg-panel-2 mt-2 overflow-hidden rounded-md border">
            <div className="flex items-center gap-1 border-b px-2 py-1.5">
              {tabs.map((t, n) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setTab(n)}
                  className={cn(
                    'rounded px-2 py-1 text-xs font-medium transition-colors',
                    n === tab
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t.label}
                </button>
              ))}
              <div className="flex-1" />
              <Button variant="ghost" size="xs" onClick={copy}>
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="max-h-[220px] overflow-auto px-3 py-3 text-[12.5px] leading-relaxed">
              <code className="text-foreground font-mono whitespace-pre">
                {current?.code}
              </code>
            </pre>
          </div>
        ) : null}

        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {steps.map((_, n) => (
              <span
                key={n}
                className={cn(
                  'size-1.5 rounded-full',
                  n === i ? 'bg-primary' : 'bg-border',
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step.docs ? (
              <a
                href={step.docs}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
              >
                Docs
                <ExternalLink className="size-3" />
              </a>
            ) : null}
            {i > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setI((n) => n - 1)}>
                <ArrowLeft className="size-3.5" />
                Back
              </Button>
            ) : null}
            {i < steps.length - 1 ? (
              <Button size="sm" onClick={() => setI((n) => n + 1)}>
                Next
                <ArrowRight className="size-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
