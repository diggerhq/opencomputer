import { useState } from 'react'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { notifyError } from '@/lib/errors'
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
}: {
  value: string
  transform?: (s: string) => string
  maskable?: boolean
  className?: string
}) {
  const [copied, markCopied] = useTransientFlag(1500)
  const [revealed, setRevealed] = useState(!maskable)

  const shown =
    maskable && !revealed ? '•'.repeat(Math.min(value.length, 32)) : value
  const displayText = transform ? transform(shown) : shown
  const copyText = transform ? transform(value) : value

  const copy = () => {
    // Only show "Copied" if the write actually succeeds (clipboard can be
    // blocked by permissions / insecure context).
    void navigator.clipboard.writeText(copyText).then(
      () => markCopied(),
      (e: unknown) => notifyError("Couldn't copy to clipboard.", e),
    )
  }

  return (
    <div
      className={cn(
        'bg-panel-2 flex items-center gap-2 rounded-md border px-3 py-2',
        className,
      )}
    >
      <code className="text-foreground flex-1 font-mono text-[13px] break-all">
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
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
