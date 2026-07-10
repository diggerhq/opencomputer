import { useState } from 'react'
import { Check, ChevronDown, Code2, Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'

export type CodeTab = { label: string; code: string }

/**
 * A collapsible "dev off-ramp": a muted "</> Show code" toggle that expands to
 * tabbed, copyable code (SDK / CLI / cURL) for whatever the adjacent one-click
 * button does under the hood. Collapsed by default so it never touches the
 * guided happy path — technical users pop it to see that the dashboard is just a
 * thin client over the public API/SDK, and copy the exact call.
 */
export function CodeOffRamp({
  tabs,
  docs,
  label = 'Show code',
  className,
}: {
  tabs: CodeTab[]
  docs?: string
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [copied, markCopied] = useTransientFlag(1500)

  const current = tabs[active] ?? tabs[0]

  const copy = () => {
    void navigator.clipboard.writeText(current.code).then(
      () => markCopied(),
      (e: unknown) => notifyError("Couldn't copy to clipboard.", e),
    )
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
        aria-expanded={open}
      >
        <Code2 className="size-3.5" />
        {label}
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform',
            open ? '' : '-rotate-90',
          )}
        />
      </button>

      {open ? (
        <div className="mt-2 overflow-hidden rounded-md border">
          <div className="bg-panel-2 flex items-center gap-1 border-b px-2 py-1.5">
            {tabs.map((t, i) => (
              <button
                key={t.label}
                type="button"
                onClick={() => setActive(i)}
                className={cn(
                  'rounded px-2 py-1 text-xs font-medium transition-colors',
                  i === active
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
            <div className="flex-1" />
            {docs ? (
              <a
                href={docs}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1 text-xs underline-offset-4 hover:underline"
              >
                Docs
                <ExternalLink className="size-3" />
              </a>
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
          <pre className="bg-panel-2 overflow-x-auto px-3 py-3 text-[12.5px] leading-relaxed">
            <code className="text-foreground font-mono">{current.code}</code>
          </pre>
        </div>
      ) : null}
    </div>
  )
}
