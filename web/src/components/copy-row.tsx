import { useState, type ReactNode } from 'react'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCopy } from '@/lib/use-copy'
import { cn } from '@/lib/utils'

/**
 * A mono code row with copy-to-clipboard (inline "Copied", not a toast).
 * Set `maskable` for secrets — adds a reveal toggle and masks the value while
 * hidden. `transform` wraps the value for display + copy (e.g. a full command).
 */
export function CopyRow({
  value,
  transform,
  maskable = false,
  className,
  onCopy,
}: {
  value: string
  transform?: (s: string) => string
  maskable?: boolean
  className?: string
  /** Called once the value is on the clipboard. */
  onCopy?: () => void
}) {
  const [revealed, setRevealed] = useState(!maskable)

  const shown =
    maskable && !revealed ? '•'.repeat(Math.min(value.length, 32)) : value
  const displayText = transform ? transform(shown) : shown
  const copyText = transform ? transform(value) : value
  const [copied, copy] = useCopy(copyText, onCopy)

  return (
    <div
      className={cn(
        'bg-panel-2 flex items-center gap-2 rounded-md border px-3 py-2',
        className,
      )}
    >
      <code className="text-foreground flex-1 font-mono text-[13px] break-all [font-variant-ligatures:none]">
        {displayText}
      </code>
      {maskable ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? 'Hide' : 'Reveal'}
        >
          {revealed ? (
            <EyeOff className="size-3.5" />
          ) : (
            <Eye className="size-3.5" />
          )}
        </Button>
      ) : null}
      <Button variant="ghost" size="xs" onClick={copy}>
        <CopyLabel copied={copied} />
      </Button>
    </div>
  )
}

/**
 * A command people copy and run, on one line however long: the lead line
 * carries the Copy button so the command gets the row's full width, and a
 * screen too narrow for it scrolls sideways rather than break it mid-word.
 */
export function CopyCommand({
  value,
  lead,
  onCopy,
}: {
  value: string
  /** What to do with it, beside the Copy button. */
  lead: ReactNode
  /** Called once the value is on the clipboard. */
  onCopy?: () => void
}) {
  const [copied, copy] = useCopy(value, onCopy)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p>{lead}</p>
        <Button variant="ghost" size="xs" onClick={copy}>
          <CopyLabel copied={copied} />
        </Button>
      </div>
      <code className="bg-panel-2 text-foreground block overflow-x-auto rounded-md border px-3 py-2 font-mono text-[11.5px] whitespace-nowrap [font-variant-ligatures:none]">
        {value}
      </code>
    </div>
  )
}

export function CopyLabel({ copied }: { copied: boolean }) {
  return (
    <>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </>
  )
}
