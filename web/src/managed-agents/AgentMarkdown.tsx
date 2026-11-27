import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

// Two sizes. sm sits in the dashboard's panels and tables. reading is for a
// thread, read for long stretches: a larger body, prose held to a measure
// while code and tables keep the full column.
const SIZE = {
  sm: {
    wrap: 'text-sm leading-6',
    prose: '',
    h1: 'mt-6 mb-3 text-xl',
    h2: 'mt-5 mb-2 text-lg',
    h3: 'mt-4 mb-2 text-base',
    pre: 'text-xs leading-5',
    table: 'text-xs',
  },
  reading: {
    wrap: 'text-reading',
    prose: 'max-w-prose',
    h1: 'mt-7 mb-2 text-xl',
    h2: 'mt-7 mb-1.5 text-lg',
    h3: 'mt-5 mb-1 text-reading',
    pre: 'my-3.5 px-3.5 text-mono',
    table: 'text-sm',
  },
}

export function AgentMarkdown({
  children,
  resolveUrl,
  inline = false,
  size = 'sm',
}: {
  children: string
  // One line set inside other text: no block wrapper, no paragraph margins.
  inline?: boolean
  size?: keyof typeof SIZE
  // Rewrites a link or image address before the usual sanitizing, such as a
  // relative link in a working doc to its place on GitHub.
  resolveUrl?: (url: string) => string
}) {
  const s = SIZE[size]
  const Wrap = inline ? 'span' : 'div'
  return (
    <Wrap className={inline ? undefined : s.wrap}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={
          resolveUrl
            ? (url) => defaultUrlTransform(resolveUrl(url))
            : defaultUrlTransform
        }
        components={{
          h1: ({ children, ...props }) => (
            <h1
              className={cn(
                'text-strong font-semibold first:mt-0',
                s.h1,
                s.prose,
              )}
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              className={cn(
                'text-strong font-semibold first:mt-0',
                s.h2,
                s.prose,
              )}
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3
              className={cn(
                'text-strong font-semibold first:mt-0',
                s.h3,
                s.prose,
              )}
              {...props}
            >
              {children}
            </h3>
          ),
          p: inline
            ? ({ children }) => <>{children}</>
            : (props) => (
                <p className={cn('mb-3 last:mb-0', s.prose)} {...props} />
              ),
          strong: (props) => (
            <strong className="text-strong font-semibold" {...props} />
          ),
          ul: (props) => (
            <ul
              className={cn(
                'marker:text-faint mb-3 list-disc space-y-1 pl-5 last:mb-0',
                s.prose,
              )}
              {...props}
            />
          ),
          ol: (props) => (
            <ol
              className={cn(
                'marker:text-faint mb-3 list-decimal space-y-1 pl-5 last:mb-0',
                s.prose,
              )}
              {...props}
            />
          ),
          li: (props) => <li className="pl-0.5" {...props} />,
          blockquote: (props) => (
            <blockquote
              className={cn(
                'text-muted-foreground my-3 border-l-2 pl-4',
                s.prose,
              )}
              {...props}
            />
          ),
          a: ({ children, ...props }) => (
            <a
              className="underline decoration-current/40 underline-offset-3 transition-colors hover:decoration-current"
              target="_blank"
              rel="noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
          code: (props) => (
            <code
              className="bg-muted text-strong rounded px-1 py-0.5 font-mono text-[0.85em]"
              {...props}
            />
          ),
          pre: (props) => (
            <pre
              className={cn(
                'bg-muted my-3 overflow-x-auto rounded-md border p-3 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em] [&_code]:text-inherit',
                s.pre,
              )}
              {...props}
            />
          ),
          hr: (props) => <hr className="my-5" {...props} />,
          table: (props) => (
            <div className="my-3 overflow-x-auto rounded-md border">
              <table
                className={cn(
                  'w-full border-collapse text-left tabular-nums [&_tr:last-child>td]:border-b-0',
                  s.table,
                )}
                {...props}
              />
            </div>
          ),
          th: (props) => (
            <th
              className="text-muted-foreground border-b px-3 py-2 font-medium"
              {...props}
            />
          ),
          td: (props) => <td className="border-b px-3 py-2" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </Wrap>
  )
}
