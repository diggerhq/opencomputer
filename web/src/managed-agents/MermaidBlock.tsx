import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { CopyLabel } from '@/components/copy-row'
import { useTheme } from '@/hooks/useTheme'
import { useCopy } from '@/lib/use-copy'
import { cachedDiagram, renderDiagram, type Rendered } from './mermaid'

// How long a block's source must hold still before it is drawn, so a burst of
// re-renders (the reply around it still streaming) draws it once.
export const RENDER_DELAY_MS = 250

// A ```mermaid block, drawn as its diagram once its closing fence has arrived.
// Until then, and whenever the diagram can't be drawn, it shows `children`:
// the plain code block. Either way Copy copies the source.
export function MermaidBlock({
  source,
  closed,
  children,
}: {
  source: string
  closed: boolean
  children: ReactNode
}) {
  const { dark } = useTheme()
  const [drawn, setDrawn] = useState<{ source: string; result: Rendered }>()
  const cached = closed ? cachedDiagram(source, dark) : undefined

  useEffect(() => {
    if (!closed || cachedDiagram(source, dark)) return
    let live = true
    const timer = setTimeout(() => {
      void renderDiagram(source, dark).then((result) => {
        if (live) setDrawn({ source, result })
      })
    }, RENDER_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [source, dark, closed])

  // On a theme change the diagram in the old theme stays up until the new one
  // is drawn, rather than falling back to code for a moment.
  const result =
    cached ?? (closed && drawn?.source === source ? drawn.result : undefined)
  const [copied, copy] = useCopy(source.replace(/\n$/, ''))

  return (
    <div className="group/mermaid relative my-3 [&>div:first-child]:my-0">
      {result && 'svg' in result ? (
        <div
          className="bg-background overflow-x-auto rounded-md border p-3 [&_svg]:mx-auto"
          data-testid="mermaid-diagram"
          // Sanitized by mermaid itself: securityLevel 'strict'.
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      ) : (
        children
      )}
      {result && 'error' in result ? (
        <p className="text-muted-foreground mt-1.5 text-xs">
          Couldn't draw this diagram: {result.error}
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="xs"
        className="bg-background/80 absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/mermaid:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        onClick={copy}
        aria-label="Copy diagram source"
      >
        <CopyLabel copied={copied} />
      </Button>
    </div>
  )
}
