import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function AgentMarkdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children, ...props }) => (
            <h1
              className="mt-6 mb-3 text-xl font-semibold first:mt-0"
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              className="mt-5 mb-2 text-lg font-semibold first:mt-0"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3
              className="mt-4 mb-2 text-base font-semibold first:mt-0"
              {...props}
            >
              {children}
            </h3>
          ),
          p: (props) => <p className="mb-3 last:mb-0" {...props} />,
          ul: (props) => (
            <ul
              className="mb-3 list-disc space-y-1 pl-5 last:mb-0"
              {...props}
            />
          ),
          ol: (props) => (
            <ol
              className="mb-3 list-decimal space-y-1 pl-5 last:mb-0"
              {...props}
            />
          ),
          li: (props) => <li className="pl-0.5" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="text-muted-foreground my-3 border-l-2 pl-4 italic"
              {...props}
            />
          ),
          a: ({ children, ...props }) => (
            <a
              className="underline underline-offset-4"
              target="_blank"
              rel="noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
          code: (props) => (
            <code
              className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]"
              {...props}
            />
          ),
          pre: (props) => (
            <pre
              className="bg-muted my-3 overflow-x-auto rounded-md border p-3 text-xs leading-5 [&_code]:bg-transparent [&_code]:p-0"
              {...props}
            />
          ),
          hr: (props) => <hr className="my-5" {...props} />,
          table: (props) => (
            <div className="my-3 overflow-x-auto rounded-md border">
              <table
                className="w-full border-collapse text-left text-xs"
                {...props}
              />
            </div>
          ),
          th: (props) => (
            <th
              className="bg-muted border-b px-3 py-2 font-medium"
              {...props}
            />
          ),
          td: (props) => <td className="border-b px-3 py-2" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
